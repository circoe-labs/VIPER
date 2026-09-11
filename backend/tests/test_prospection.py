"""Prospection semantics and ProspectQueryService (Task 14) against the real test database.

One synthetic person per edge case ("Cas <key>"), each segment's expected members written out, and
counters compared with list totals — the definitions in doc/features/prospection-kpis.md.
"""

import random
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.core.business_time import BUSINESS_TIMEZONE
from app.models import (
    Company,
    ContactTracking,
    ImportBatch,
    InternalReferent,
    Prospect,
    ProspectSource,
)
from app.models.enums import (
    ActivityStatus,
    ContactabilityStatus,
    ContactTrackingStatus,
    ProspectSourceType,
    VerificationStatus,
)
from app.services import prospects as prospect_service
from app.services.prospection.query import (
    NONE,
    ProspectFilters,
    ProspectSort,
    count_segments,
    list_prospects,
)
from app.services.prospection.segments import (
    EmailState,
    Segment,
    SegmentContext,
    VerificationState,
)
from tests.builders import (
    OPERATOR,
    add_company,
    add_email,
    add_phone,
    add_prospect,
    add_role,
    statements,
)

TODAY = date(2026, 9, 10)
CONTEXT = SegmentContext(today=TODAY)
S = ContactTrackingStatus
VERIFIED = {"verification_status": VerificationStatus.VERIFIED}


def at(day: date, hour: int = 9) -> datetime:
    """`day` at `hour` o'clock, business time."""
    return datetime(day.year, day.month, day.day, hour, tzinfo=BUSINESS_TIMEZONE)


def track(session: Session, prospect: Prospect, status: S = S.TO_CONTACT, **fields: Any) -> None:
    session.add(ContactTracking(prospect_id=prospect.id, status=status, **fields))
    session.flush()


def block(**fields: Any) -> dict[str, Any]:
    return {
        "contactability_status": ContactabilityStatus.DO_NOT_CONTACT,
        "do_not_contact_at": datetime(2026, 1, 1, tzinfo=UTC),
        **fields,
    }


def case(session: Session, company: Company, key: str, **fields: Any) -> Prospect:
    return add_prospect(session, company, first_name="Cas", last_name=key, **fields)


def names(session: Session, segment: Segment, filters: ProspectFilters | None = None) -> set[str]:
    page = list_prospects(
        session, filters or ProspectFilters(), CONTEXT, segment=segment, limit=200
    )
    return {row.last_name or "" for row in page.items}


@pytest.fixture
def cases(db_session: Session) -> dict[str, Prospect]:
    """One prospect per edge case of the segment definitions."""
    s = db_session
    company = add_company(s, "Transports Exemple SARL")
    other = add_company(s, "Nouvel Employeur SAS")
    verified_at = at(TODAY - timedelta(days=9))
    made: dict[str, Prospect] = {}

    made["plain"] = case(s, company, "plain")
    made["verified"] = case(
        s, company, "verified", employment_verified_at=verified_at, activity_status="active"
    )
    add_email(s, made["verified"], "verified@exemple.example", is_primary=True, **VERIFIED)

    made["reset"] = case(s, company, "reset", employment_verified_at=verified_at)
    add_email(
        s,
        made["reset"],
        "reset@exemple.example",
        is_primary=True,
        last_verified_at=verified_at,
    )
    made["phone_reset"] = case(s, company, "phone_reset", employment_verified_at=verified_at)
    add_phone(s, made["phone_reset"], "+33100000001", last_verified_at=verified_at)
    # A former (inactive) channel reset long ago asks for nothing.
    made["former_reset"] = case(s, company, "former_reset", employment_verified_at=verified_at)
    add_email(
        s,
        made["former_reset"],
        "old@exemple.example",
        is_active=False,
        last_verified_at=verified_at,
    )

    made["moved"] = case(s, company, "moved", employment_verified_at=verified_at)
    add_email(
        s,
        made["moved"],
        "moved@exemple.example",
        is_primary=True,
        last_verified_at=verified_at,
        **VERIFIED,
    )
    prospect_service.change_company(s, OPERATOR, made["moved"].id, other.id)

    made["old_verification"] = case(
        s, company, "old_verification", employment_verified_at=at(date(2025, 1, 6))
    )
    made["invalid_email"] = case(s, company, "invalid_email")
    add_email(
        s,
        made["invalid_email"],
        "invalide@exemple.example",
        is_primary=True,
        verification_status=VerificationStatus.INVALID,
    )
    made["unknown_email"] = case(s, company, "unknown_email")
    add_email(
        s,
        made["unknown_email"],
        "inconnu@exemple.example",
        is_primary=True,
        verification_status=VerificationStatus.UNKNOWN,
    )
    made["secondary_email"] = case(s, company, "secondary_email")
    add_email(s, made["secondary_email"], "second@exemple.example", **VERIFIED)

    made["due_today"] = case(s, company, "due_today")
    track(s, made["due_today"], planned_contact_at=at(TODAY, 18))
    made["due_past"] = case(s, company, "due_past", activity_status="active")
    track(s, made["due_past"], planned_contact_at=at(TODAY - timedelta(days=9)))
    made["planned_tomorrow"] = case(s, company, "planned_tomorrow")
    track(s, made["planned_tomorrow"], planned_contact_at=at(TODAY + timedelta(days=1), 0))
    made["unplanned"] = case(s, company, "unplanned")
    track(s, made["unplanned"])
    made["blocked_due"] = case(s, company, "blocked_due", **block())
    track(s, made["blocked_due"], planned_contact_at=at(TODAY - timedelta(days=2)))
    made["inactive_due"] = case(s, company, "inactive_due", activity_status="inactive")
    track(s, made["inactive_due"], planned_contact_at=at(TODAY - timedelta(days=2)))

    made["waiting"] = case(s, company, "waiting")
    track(s, made["waiting"], S.CONTACTED)
    made["follow_up"] = case(s, company, "follow_up")
    track(s, made["follow_up"], S.FOLLOW_UP_2)
    made["blocked_waiting"] = case(s, company, "blocked_waiting", **block())
    track(s, made["blocked_waiting"], S.CONTACTED)
    made["answered"] = case(s, company, "answered")
    track(s, made["answered"], S.FOLLOW_UP_1, response_received_at=at(TODAY))
    made["not_interested"] = case(s, company, "not_interested")
    track(s, made["not_interested"], S.NOT_INTERESTED)
    made["appointment"] = case(s, company, "appointment")
    track(
        s,
        made["appointment"],
        S.APPOINTMENT_OBTAINED,
        response_received_at=at(TODAY),
        appointment_at=at(TODAY + timedelta(days=3)),
    )
    # An appointment date on a stage left at `to_contact` (e.g. an explorer edit) still counts.
    made["appointment_date_only"] = case(s, company, "appointment_date_only")
    track(s, made["appointment_date_only"], appointment_at=at(TODAY))
    made["won"] = case(s, company, "won")
    track(s, made["won"], S.WON)
    s.flush()
    return made


# Every case, then each segment's members. `to_contact` = actionable and never contacted.
ALL_CASES = {
    "plain",
    "verified",
    "reset",
    "phone_reset",
    "former_reset",
    "moved",
    "old_verification",
    "invalid_email",
    "unknown_email",
    "secondary_email",
    "due_today",
    "due_past",
    "planned_tomorrow",
    "unplanned",
    "blocked_due",
    "inactive_due",
    "waiting",
    "follow_up",
    "blocked_waiting",
    "answered",
    "not_interested",
    "appointment",
    "appointment_date_only",
    "won",
}
VERIFIED_CASES = {"verified", "reset", "phone_reset", "former_reset", "old_verification"}
CONTACTED_CASES = {
    "waiting",
    "follow_up",
    "blocked_waiting",
    "answered",
    "not_interested",
    "appointment",
    "appointment_date_only",
    "won",
}
EXPECTED: dict[Segment, set[str]] = {
    Segment.ALL: ALL_CASES,
    Segment.NEVER_VERIFIED: ALL_CASES - VERIFIED_CASES,
    Segment.NEEDS_RECHECK: {"reset", "phone_reset"},
    Segment.ACTIVE: {"verified", "due_past"},
    Segment.INACTIVE: {"inactive_due"},
    Segment.UNKNOWN: ALL_CASES - {"verified", "due_past", "inactive_due"},
    Segment.DO_NOT_CONTACT: {"blocked_due", "blocked_waiting"},
    Segment.EMAIL_MISSING: ALL_CASES
    - {"verified", "reset", "moved", "invalid_email", "unknown_email"},
    Segment.EMAIL_INVALID: {"invalid_email"},
    Segment.EMAIL_UNVERIFIED: {"reset", "moved", "unknown_email"},
    Segment.TO_CONTACT: ALL_CASES - CONTACTED_CASES - {"blocked_due", "inactive_due"},
    Segment.DUE: {"due_today", "due_past"},
    Segment.CONTACTED: CONTACTED_CASES,
    Segment.NO_RESPONSE: {"waiting", "follow_up"},
    Segment.RESPONSES: {
        "answered",
        "not_interested",
        "appointment",
        "appointment_date_only",
        "won",
    },
    Segment.APPOINTMENTS: {"appointment", "appointment_date_only", "won"},
}


def test_expected_table_covers_every_segment() -> None:
    assert set(EXPECTED) == set(Segment)


@pytest.mark.parametrize("segment", list(Segment))
def test_segment_members(db_session: Session, cases: dict[str, Prospect], segment: Segment) -> None:
    assert names(db_session, segment) == EXPECTED[segment]


def test_counters_equal_the_expected_members(
    db_session: Session, cases: dict[str, Prospect]
) -> None:
    counted = count_segments(db_session, ProspectFilters(), CONTEXT)

    assert counted.counts == {segment: len(EXPECTED[segment]) for segment in Segment}
    assert (counted.today, counted.stale_threshold_days) == (TODAY, None)


def test_company_change_is_never_verified_until_verified_again(
    db_session: Session, cases: dict[str, Prospect]
) -> None:
    moved = cases["moved"]
    assert "moved" in names(db_session, Segment.NEVER_VERIFIED)

    moved.employment_verified_at = at(TODAY)
    db_session.flush()

    # Employment checked again, but the e-mail verified at the former company still is not.
    assert "moved" in names(db_session, Segment.NEEDS_RECHECK)
    assert "moved" not in names(db_session, Segment.NEVER_VERIFIED)


def test_stale_threshold_applies_only_when_configured(
    db_session: Session, cases: dict[str, Prospect]
) -> None:
    configured = SegmentContext(today=TODAY, stale_days=365)
    page = list_prospects(
        db_session, ProspectFilters(), configured, segment=Segment.NEEDS_RECHECK, limit=200
    )
    states = {row.last_name: row.verification_state for row in page.items}

    assert states == {
        "reset": VerificationState.CHANNELS_RESET,
        "phone_reset": VerificationState.CHANNELS_RESET,
        "old_verification": VerificationState.STALE,
    }
    assert count_segments(db_session, ProspectFilters(), configured).stale_threshold_days == 365
    # The threshold is the start of the day N days ago: verified on that day is not stale yet.
    boundary = SegmentContext(today=date(2026, 1, 6), stale_days=365)
    assert boundary.stale_before == at(date(2025, 1, 6), 0)
    assert "old_verification" not in {
        row.last_name
        for row in list_prospects(
            db_session, ProspectFilters(), boundary, segment=Segment.NEEDS_RECHECK
        ).items
    }


def test_due_follows_the_business_day() -> None:
    late_evening_utc = datetime(2026, 9, 10, 22, 30, tzinfo=UTC)  # already the 11th in Paris

    context = SegmentContext.at(late_evening_utc)

    assert context.today == date(2026, 9, 11)
    assert context.due_before == at(date(2026, 9, 12), 0)


def test_row_states_are_explicit(db_session: Session, cases: dict[str, Prospect]) -> None:
    rows = {
        row.last_name: row
        for row in list_prospects(db_session, ProspectFilters(), CONTEXT, limit=200).items
    }

    assert rows["plain"].verification_state is VerificationState.NEVER_VERIFIED
    assert rows["verified"].verification_state is VerificationState.VERIFIED
    assert rows["reset"].verification_state is VerificationState.CHANNELS_RESET
    assert rows["old_verification"].verification_state is VerificationState.VERIFIED
    assert {name: rows[name].email_state for name in ("plain", "verified", "invalid_email")} == {
        "plain": EmailState.MISSING,
        "verified": EmailState.VERIFIED,
        "invalid_email": EmailState.INVALID,
    }
    assert rows["unknown_email"].email_state is EmailState.UNVERIFIED
    assert rows["secondary_email"].email_state is EmailState.MISSING
    assert rows["blocked_due"].contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert rows["plain"].tracking_status is None
    assert {name for name, row in rows.items() if row.due} == EXPECTED[Segment.DUE]


def test_row_view_model_resolves_labels_and_week(db_session: Session) -> None:
    company = add_company(db_session, "Logistique Témoin SAS")
    role = add_role(db_session, "responsable-transport-test", "Responsable transport test")
    referent = InternalReferent(first_name="Camille", last_name="Référente")
    db_session.add(referent)
    prospect = add_prospect(
        db_session,
        company,
        first_name="Élodie",
        last_name="Exemple",
        civility="ms",
        role_id=role.id,
        exact_job_title="Directrice des opérations fictive",
    )
    add_email(db_session, prospect, "elodie@temoin.example", is_primary=True)
    add_email(db_session, prospect, "autre@temoin.example")
    add_phone(db_session, prospect, "+33600000001", type="mobile", is_primary=True)
    track(
        db_session,
        prospect,
        S.APPOINTMENT_OBTAINED,
        planned_contact_at=at(date(2026, 9, 14)),
        referent_id=referent.id,
    )

    (row,) = list_prospects(db_session, ProspectFilters(), CONTEXT).items

    assert (row.company_id, row.company_name, row.role_label) == (
        company.id,
        "Logistique Témoin SAS",
        "Responsable transport test",
    )
    assert row.exact_job_title == "Directrice des opérations fictive"
    assert (row.primary_email, row.primary_email_status) == (
        "elodie@temoin.example",
        VerificationStatus.UNVERIFIED,
    )
    assert (row.primary_phone, row.primary_phone_type) == ("+33600000001", "mobile")
    assert (row.tracking_status, row.planned_contact_week) == (S.APPOINTMENT_OBTAINED, "2026-W38")
    assert (row.referent_id, row.referent_name) == (referent.id, "Camille Référente")


def test_week_uses_the_business_day(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    # Sunday 23:30 UTC is already Monday in Paris: week 38, not 37.
    track(db_session, prospect, planned_contact_at=datetime(2026, 9, 13, 23, 30, tzinfo=UTC))

    (row,) = list_prospects(db_session, ProspectFilters(), CONTEXT).items

    assert row.planned_contact_week == "2026-W38"


# --- search and filters -------------------------------------------------------------------------


@pytest.fixture
def people(db_session: Session) -> dict[str, Prospect]:
    s = db_session
    transports = add_company(s, "Transports Exemple SARL", legal_name="Exemple Holding")
    logistique = add_company(s, "Logistique Démo SAS")
    made = {
        "elodie": add_prospect(s, transports, first_name="Élodie", last_name="Martin-Test"),
        "jean": add_prospect(s, logistique, first_name="Jean", last_name="Fictif"),
        "zoe": add_prospect(s, None, first_name="Zoé", last_name="Sans-Entreprise"),
    }
    add_email(s, made["jean"], "j.fictif@demo-logistique.example", is_primary=True)
    add_email(s, made["zoe"], "zoe.ancienne@ailleurs.example", is_active=False)
    add_phone(s, made["elodie"], "+33612345678", type="mobile", is_primary=True)
    add_phone(s, made["jean"], "0412345678")
    return made


@pytest.mark.parametrize(
    ("search", "expected"),
    [
        ("elodie", {"Martin-Test"}),  # accents ignored
        ("MARTIN", {"Martin-Test"}),  # case ignored
        ("transports", {"Martin-Test"}),  # company display name
        ("holding", {"Martin-Test"}),  # company legal name
        ("demo jean", {"Fictif"}),  # every word, across person and company
        ("demo élodie", set()),
        ("demo-logistique.example", {"Fictif"}),  # e-mail address
        ("ancienne@", {"Sans-Entreprise"}),  # any e-mail, even a former one
        ("06 12 34 56 78", {"Martin-Test"}),  # national format of a stored +33 number
        ("+33 6 12", {"Martin-Test"}),
        ("12345678", {"Martin-Test", "Fictif"}),
        ("1234", {"Martin-Test", "Fictif"}),
        ("123", set()),  # too short to be a phone number
        ("100%", set()),  # LIKE wildcards are literal
    ],
)
def test_search(
    db_session: Session, people: dict[str, Prospect], search: str, expected: set[str]
) -> None:
    assert names(db_session, Segment.ALL, ProspectFilters(search=search)) == expected
    counted = count_segments(db_session, ProspectFilters(search=search), CONTEXT)
    assert counted.counts[Segment.ALL] == len(expected)


def test_filters_combine(db_session: Session) -> None:
    s = db_session
    transports, logistique = add_company(s), add_company(s, "Logistique Démo SAS")
    role = add_role(s)
    referent = InternalReferent(first_name="Alex", last_name="Exemple")
    s.add(referent)
    batch = ImportBatch(filename="base.xlsx", actor_type=ActorType.HUMAN, actor_display="Test")
    s.add(batch)
    s.flush()

    def person(key: str, company: Company, **fields: Any) -> Prospect:
        return add_prospect(s, company, first_name="Filtre", last_name=key, **fields)

    a = person("a", transports, role_id=role.id, activity_status="active")
    b = person("b", transports, role_id=role.id)
    c = person("c", logistique)
    person("d", logistique, activity_status="active")
    track(s, a, S.CONTACTED, referent_id=referent.id)
    track(s, b, planned_contact_at=at(TODAY))
    track(s, c, S.CONTACTED)
    s.add(ProspectSource(prospect_id=b.id, source_type=ProspectSourceType.EXCEL_IMPORT))
    s.add_all(
        ProspectSource(
            prospect_id=p.id, source_type=ProspectSourceType.EXCEL_IMPORT, import_batch_id=batch.id
        )
        for p in (a, c)
    )
    s.flush()

    checks: list[tuple[ProspectFilters, Segment, set[str]]] = [
        (ProspectFilters(role=role.id), Segment.ALL, {"a", "b"}),
        (ProspectFilters(role=NONE), Segment.ALL, {"c", "d"}),
        (ProspectFilters(activity=ActivityStatus.ACTIVE), Segment.ALL, {"a", "d"}),
        (ProspectFilters(referent=referent.id), Segment.ALL, {"a"}),
        (ProspectFilters(referent=NONE), Segment.ALL, {"b", "c", "d"}),
        (ProspectFilters(tracking_status=S.CONTACTED), Segment.ALL, {"a", "c"}),
        (ProspectFilters(tracking_status=NONE), Segment.ALL, {"d"}),
        (ProspectFilters(company_id=logistique.id), Segment.ALL, {"c", "d"}),
        (ProspectFilters(import_batch_id=batch.id), Segment.ALL, {"a", "c"}),
        (ProspectFilters(company_id=transports.id, role=role.id), Segment.DUE, {"b"}),
        (
            ProspectFilters(import_batch_id=batch.id, activity=ActivityStatus.ACTIVE),
            Segment.NO_RESPONSE,
            {"a"},
        ),
        (ProspectFilters(search="filtre", company_id=logistique.id), Segment.TO_CONTACT, {"d"}),
        (ProspectFilters(company_id=uuid.uuid4()), Segment.ALL, set()),
    ]
    for filters, segment, expected in checks:
        assert names(s, segment, filters) == expected, (filters, segment)
        assert count_segments(s, filters, CONTEXT).counts[segment] == len(expected)


# --- counters == list, paging, sorting, statements ---------------------------------------------


def random_base(session: Session, seed: int, size: int = 60) -> None:
    """A random but reproducible mix of every state the predicates read."""
    rng = random.Random(seed)
    companies = [add_company(session, f"Entreprise Aléatoire {n}") for n in range(4)]
    for n in range(size):
        blocked = rng.random() < 0.15
        prospect = add_prospect(
            session,
            rng.choice([*companies, None]),
            first_name=rng.choice(["Jean", "Marie", "Luc"]),
            last_name=f"Aléa{n % 7}",
            activity_status=rng.choice(list(ActivityStatus)),
            employment_verified_at=rng.choice(
                [None, at(TODAY - timedelta(days=rng.randrange(900)))]
            ),
            **(block() if blocked else {}),
        )
        if rng.random() < 0.7:
            add_email(
                session,
                prospect,
                f"alea{n}@exemple.example",
                is_primary=rng.random() < 0.8,
                verification_status=rng.choice(list(VerificationStatus)),
                last_verified_at=rng.choice([None, at(TODAY - timedelta(days=30))]),
            )
        if rng.random() < 0.6:
            day = TODAY + timedelta(days=rng.randrange(-20, 20))
            track(
                session,
                prospect,
                rng.choice(list(S)),
                planned_contact_at=rng.choice([None, at(day)]),
                response_received_at=rng.choice([None, None, at(TODAY)]),
                appointment_at=rng.choice([None, None, None, at(day)]),
            )


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_every_counter_equals_its_list_total(db_session: Session, seed: int) -> None:
    random_base(db_session, seed)
    contexts = [CONTEXT, SegmentContext(today=TODAY, stale_days=180)]
    filter_sets = [
        ProspectFilters(),
        ProspectFilters(search="jean"),
        ProspectFilters(activity=ActivityStatus.UNKNOWN, tracking_status=NONE),
    ]
    for context in contexts:
        for filters in filter_sets:
            counted = count_segments(db_session, filters, context).counts
            for segment in Segment:
                page = list_prospects(db_session, filters, context, segment=segment, limit=200)
                assert counted[segment] == page.total == len(page.items), (segment, filters)


@pytest.mark.parametrize("sort", list(ProspectSort))
def test_paging_is_stable_for_every_sort(db_session: Session, sort: ProspectSort) -> None:
    random_base(db_session, seed=7, size=40)
    whole = [
        row.id for row in list_prospects(db_session, ProspectFilters(), CONTEXT, sort=sort).items
    ]

    paged: list[uuid.UUID] = []
    for offset in range(0, 40, 7):
        page = list_prospects(
            db_session, ProspectFilters(), CONTEXT, sort=sort, limit=7, offset=offset
        )
        assert page.total == 40
        paged += [row.id for row in page.items]

    assert paged == whole
    assert len(set(paged)) == 40


def test_sort_orders(db_session: Session) -> None:
    company_b, company_a = add_company(db_session, "Beta SAS"), add_company(db_session, "Alpha SAS")
    early = add_prospect(
        db_session, company_b, first_name="Anne", last_name="Zola", employment_verified_at=at(TODAY)
    )
    late = add_prospect(db_session, company_a, first_name="Bruno", last_name="Ábel")
    add_prospect(
        db_session,
        None,
        first_name="Chloé",
        last_name="Martin",
        employment_verified_at=at(TODAY - timedelta(days=5)),
    )
    track(db_session, early, planned_contact_at=at(TODAY))
    track(db_session, late, planned_contact_at=at(TODAY + timedelta(days=2)))

    def order(sort: ProspectSort) -> list[str | None]:
        page = list_prospects(db_session, ProspectFilters(), CONTEXT, sort=sort)
        return [row.last_name for row in page.items]

    assert order(ProspectSort.NAME) == ["Ábel", "Martin", "Zola"]  # accents ignored
    assert order(ProspectSort.COMPANY) == ["Ábel", "Zola", "Martin"]  # no company last
    assert order(ProspectSort.PLANNED_CONTACT) == ["Zola", "Ábel", "Martin"]
    assert order(ProspectSort.VERIFICATION) == ["Ábel", "Martin", "Zola"]


@pytest.mark.parametrize("size", [3, 60])
def test_statement_count_does_not_grow_with_rows(db_session: Session, size: int) -> None:
    random_base(db_session, seed=11, size=size)
    db_session.expunge_all()
    with statements(db_session) as page_statements:
        page = list_prospects(db_session, ProspectFilters(), CONTEXT, limit=200)
    with statements(db_session) as counter_statements:
        count_segments(db_session, ProspectFilters(search="jean"), CONTEXT)

    assert len(page.items) == size
    assert len(page_statements) == 2  # the page, then its total
    assert len(counter_statements) == 1  # every counter in one aggregate
    assert "FILTER (WHERE" in counter_statements[0]
