"""Operational meaning of the Circoe prospecting workbook: cohorts, sequences, imported sends and
« Défaillant » (sequences rework, Slice S2; decisions D3, D4, D5, D6, D11).

Run by `import_commit.Committer` inside the import's savepoint, once the companies and prospects
exist, per prospect created or completed by the file (its rows in source order):

- **cohort** (`Sxx` of the first `A contacter` column, `S0` included): a prospect the import
  created, or an existing one that never had a cohort, opens a sequence in it (import actor). When
  the cohort's real date is past, its Contact is recorded as sent at that date (source `import`,
  D3) — S0 has no date and nobody in it is contacted. An existing prospect whose cohort (or past
  sequence, or contact state) differs keeps it: an `import_conflict` alert says so (D11). Two rows
  of one prospect with different codes: the first applies, the others raise the same alert;
- **function verified** (handoff §6): a prospect in the row's cohort after the import gets an empty
  `employment_verified_at` filled — the cohort's past date, else the import's moment — unless a
  person set or cleared it (D11; R-20);
- **not a cohort** (`retraité`…): a `data_inconsistent` alert on the prospect, raw value kept;
- **« Défaillant »** (D4): only when the person declared the file verified (« Fichier vérifié
  humainement »), a prospect the import created without any valid cohort becomes `disqualified`
  — by **that person** (the state is a human decision; the import actor or the AI never sets it);
  an existing prospect only when it has no cohort history and no state a person chose, otherwise
  an `import_conflict` alert. A prospect whose rows set another state (an appointment) is left
  as it is. Without the declaration, rows without cohort stay `neutral` without cohort.

A prospect under the do-not-contact opposition is never touched. Nothing here reads
`Statut_verification` (the activity is applied with the other prospect fields, D10) nor any
e-mail verification. Every write goes through the S1 services (audited); re-importing the same
file changes nothing: same cohort → nothing, alerts are raised once (`import_precedence`).
"""

import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.core.business_time import BUSINESS_TIMEZONE
from app.models import Cohort, ContactSequence, Prospect
from app.models.enums import ContactabilityStatus, ContactTrackingStatus
from app.services import audit, contact_messages, contact_sequences, prospects
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.contact_workflow import SEQUENCE_CLOSING_STATES
from app.services.import_precedence import (
    AlertRecorder,
    Reason,
    RowRef,
    human_fields,
    human_state,
)

S = ContactTrackingStatus


@dataclass(frozen=True, slots=True)
class RowClaim:
    """What one source row says about the prospect's place in Contact."""

    row: int
    cohort_code: str | None  # normalized `S<n>`
    not_cohort: str | None  # the cohort cell's text when it is not a cohort code


@dataclass(frozen=True, slots=True)
class ProspectClaims:
    prospect_id: uuid.UUID
    created: bool  # created by this import (else an existing prospect completed by it)
    rows: tuple[RowClaim, ...]


def business_today() -> date:
    return datetime.now(BUSINESS_TIMEZONE).date()


def cohort_moment(day: date) -> datetime:
    """The cohort's date at business midnight: the moment of its imported Contact send."""
    return datetime.combine(day, time(), tzinfo=BUSINESS_TIMEZONE)


@dataclass
class OperationalReconciler:
    session: Session
    person: ActorContext  # the person who validates the import (« Défaillant »)
    importer: ActorContext  # the import actor (sequences, sends, alerts)
    alerts: AlertRecorder
    human_verified: bool
    ref: Callable[[int], RowRef]
    today: date = field(default_factory=business_today)
    now: datetime = field(default_factory=lambda: datetime.now(UTC))
    counts: Counter[str] = field(default_factory=Counter)
    # Rows whose cohort was not applied (their raw cell stays in the row's legacy metadata).
    unapplied: set[int] = field(default_factory=set)
    _cohorts: dict[str, Cohort] | None = None

    def cohort(self, code: str) -> Cohort:
        if self._cohorts is None:
            self._cohorts = {c.code: c for c in self.session.scalars(select(Cohort))}
        return self._cohorts[code]

    def apply(self, claims: ProspectClaims) -> None:
        prospect = prospects.get_prospect(self.session, claims.prospect_id)
        for claim in claims.rows:
            if claim.not_cohort is not None:
                self.alerts.not_a_cohort(self.ref(claim.row), prospect.id, claim.not_cohort)
        if prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT:
            self.unapplied.update(c.row for c in claims.rows if c.cohort_code)
            return
        with_code = [claim for claim in claims.rows if claim.cohort_code is not None]
        if with_code:
            first = with_code[0]
            assert first.cohort_code is not None
            for other in with_code[1:]:
                if other.cohort_code != first.cohort_code:
                    self.unapplied.add(other.row)
                    self.alerts.conflict(
                        self.ref(other.row),
                        "cohort",
                        first.cohort_code,
                        other.cohort_code,
                        prospect_id=prospect.id,
                    )
            if (cohort := self.place_in_cohort(prospect, claims, first)) is not None:
                self.verify_employment(prospect, claims, cohort)
        elif self.human_verified:
            self.disqualify(prospect, claims)

    # --- cohort ---

    def place_in_cohort(
        self, prospect: Prospect, claims: ProspectClaims, claim: RowClaim
    ) -> Cohort | None:
        """The cohort the prospect is in after the row (opened now, or already the same), None
        when the row's cohort was not applied (conflict)."""
        code = claim.cohort_code
        assert code is not None
        ref = self.ref(claim.row)
        current = contact_sequences.current_sequence(self.session, prospect.id)
        if current is not None:
            if current.cohort.code != code:
                self.unapplied.add(claim.row)
                self.alerts.conflict(
                    ref, "cohort", current.cohort.code, code, prospect_id=prospect.id
                )
                return None
            return current.cohort
        state = prospect.contact_tracking.status if prospect.contact_tracking else None
        if not claims.created:
            if self.had_sequence(prospect.id):  # a person removed its cohort
                self.unapplied.add(claim.row)
                self.alerts.conflict(
                    ref, "cohort", None, code, prospect_id=prospect.id, reason=Reason.HUMAN_CLEARED
                )
                return None
            if state not in (None, S.NEUTRAL):
                self.unapplied.add(claim.row)
                self.alerts.conflict(ref, "cohort", state, code, prospect_id=prospect.id)
                return None
        cohort = self.cohort(code)
        contact_sequences.open_imported_sequence(
            self.session,
            self.importer,
            prospect.id,
            cohort.id,
            state_from_this_import=claims.created,  # an appointment of the same file
        )
        self.counts["sequences_opened"] += 1
        past = cohort.starts_on is not None and cohort.starts_on < self.today
        if past and state not in SEQUENCE_CLOSING_STATES and not cohort.out_of_campaign:
            assert cohort.starts_on is not None
            contact_messages.record_imported_send(
                self.session, self.importer, prospect.id, sent_at=cohort_moment(cohort.starts_on)
            )
            self.counts["sends_recorded"] += 1
        return cohort

    # --- function verified (handoff §6, R-20) ---

    def verify_employment(self, prospect: Prospect, claims: ProspectClaims, cohort: Cohort) -> None:
        """A row with a valid cohort (S0 included) says that a person verified the prospect's
        function in its company: `employment_verified_at` is filled when empty — at the cohort's
        date when it is past (the function was verified before its first send), else at the
        import's moment; never in the future. D11: a value already there is kept (a different
        date is no conflict), and a moment a person set or cleared is never refilled."""
        if prospect.employment_verified_at is not None:
            return
        if not claims.created and "employment_verified_at" in human_fields(
            self.session, "prospect", prospect.id
        ):
            return
        verified_at = self.now
        if cohort.starts_on is not None:
            verified_at = min(cohort_moment(cohort.starts_on), verified_at)
        audit.annotate(self.session, self.importer, prospect)
        prospect.employment_verified_at = verified_at
        self.session.flush()
        self.counts["employments_verified"] += 1

    def had_sequence(self, prospect_id: uuid.UUID) -> bool:
        return bool(
            self.session.scalar(select(exists().where(ContactSequence.prospect_id == prospect_id)))
        )

    # --- « Défaillant » (D4) ---

    def disqualify(self, prospect: Prospect, claims: ProspectClaims) -> None:
        tracking = prospect.contact_tracking
        state = tracking.status if tracking else None
        if state is S.DISQUALIFIED:
            return
        ref = self.ref(claims.rows[0].row)
        if claims.created:
            if state not in (None, S.NEUTRAL):
                return  # the file itself gave this new prospect a state (an appointment)
        else:
            current = contact_sequences.current_sequence(self.session, prospect.id)
            chosen = state not in (None, S.NEUTRAL) or (
                state is S.NEUTRAL and human_state(self.session, prospect.id)
            )
            if current is not None or self.had_sequence(prospect.id) or chosen:
                viper = current.cohort.code if current is not None else state
                self.alerts.conflict(
                    ref, "contact_state", viper, S.DISQUALIFIED, prospect_id=prospect.id
                )
                return
        save_contact_tracking(
            self.session,
            self.person,
            prospect.id,
            ContactTrackingInput(
                status=S.DISQUALIFIED,
                referent_id=tracking.referent_id if tracking else None,
                response_received_at=tracking.response_received_at if tracking else None,
                appointment_at=tracking.appointment_at if tracking else None,
            ),
        )
        self.counts["prospects_disqualified"] += 1
