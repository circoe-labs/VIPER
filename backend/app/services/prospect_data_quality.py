"""Fiche completeness of a prospect (« Qualité de la fiche »): how reachable and how trustworthy the
record is, computed on the backend from the record itself, deterministically (no LLM).

PRODUCT VOCABULARY (slice S2): the user sees a named **state**, never a number --
`incomplete` « Incomplète » < `usable` « Exploitable » < `rich` « Fournie » < `very_rich`
« Très fournie » -- with a one-sentence explanation and a criterion breakdown (`met` / `partial` /
`missing`). It is independent of the commercial-fit score (`app.services.prospect_score`):
completeness says how much we know, not whether the prospect is worth pursuing.

IMPLEMENTATION DETAIL: the state is derived from a private 0..100 point total (each criterion is
worth fixed points, the maximums add up to 100). `total`, `band`, `points` and `max_points` stay on
the wire only as a compatibility adapter (the prospects dashboard and older consumers still read
them); they are NOT product vocabulary and the UI must not display them. Remove once S7 / the
dashboard no longer need them. Never stored, computed on read.

State rule: points thresholds (`DataQualityConfig.usable_from` / `rich_from` / `very_rich_from`),
with one gate: a record with no active e-mail and no active phone cannot be reached, so it is
`incomplete` whatever its points.

| Criterion         | Max | Rule                                                 |
|-------------------|----:|------------------------------------------------------|
| E-mail actif      |  20 | an active e-mail exists                              |
| E-mail vérifié    |  20 | the primary (else any active) e-mail is verified     |
| Téléphone         |  10 | an active phone exists                               |
| Téléphone vérifié |   5 | an active phone is verified                          |
| Emploi vérifié    |  15 | verified and fresh = 15, verified but stale = 8      |
| Activité connue   |   5 | `activity_status` is not `unknown`                   |
| Entreprise        |  10 | linked to a company                                  |
| Rôle              |  10 | a role is set                                        |
| Intitulé exact    |   5 | the exact job title is filled                        |

An `invalid` e-mail never counts as verified; a prospect with durable opposition has no score
(`None` upstream, the UI shows « Écarté »).
"""

from collections.abc import Collection, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Settings
from app.models.enums import ActivityStatus, VerificationStatus
from app.models.prospects import Email, Phone, Prospect
from app.services.prospect_score import SCORE_MAX, SCORE_MIN, ScoreBand

STALE_EMPLOYMENT_POINTS = 8


class CompletenessState(StrEnum):
    """Public vocabulary of the fiche completeness, from least to most provided."""

    INCOMPLETE = "incomplete"
    USABLE = "usable"
    RICH = "rich"
    VERY_RICH = "very_rich"


class CriterionStatus(StrEnum):
    MET = "met"
    PARTIAL = "partial"
    MISSING = "missing"


# French label and meaning per state (the meaning feeds the UI tooltip).
STATE_LABELS: dict[CompletenessState, str] = {
    CompletenessState.INCOMPLETE: "Incomplète",
    CompletenessState.USABLE: "Exploitable",
    CompletenessState.RICH: "Fournie",
    CompletenessState.VERY_RICH: "Très fournie",
}
STATE_DESCRIPTIONS: dict[CompletenessState, str] = {
    CompletenessState.INCOMPLETE: "Trop peu d'informations, ou aucun moyen de joindre la personne.",
    CompletenessState.USABLE: "On peut joindre la personne, mais plusieurs informations manquent.",
    CompletenessState.RICH: "Coordonnées et profil bien renseignés, quelques points à vérifier.",
    CompletenessState.VERY_RICH: "Coordonnées, profil et emploi renseignés et vérifiés.",
}


class DataQualityCriterion(BaseModel):
    """One line of the breakdown: `Téléphone vérifié — 0/5`."""

    model_config = ConfigDict(frozen=True)

    id: str
    label: str
    # Implementation detail (see module docstring): the UI shows `status`, not the points.
    points: int
    max_points: int
    status: CriterionStatus
    # Short French explanation of what was found (« Aucun e-mail actif »).
    detail: str


class DataQualityScore(BaseModel):
    """Wire contract of the completeness (`ProfileCompleteness` on the frontend): `state`,
    `state_label`, `state_description`, `summary`, `criteria`. `total` and `band` are the deprecated
    numeric compatibility adapter."""

    model_config = ConfigDict(frozen=True)

    state: CompletenessState
    state_label: str
    state_description: str
    # Deprecated compatibility adapter (dashboard, older clients): never display.
    total: int = Field(ge=SCORE_MIN, le=SCORE_MAX)
    band: ScoreBand
    summary: str
    criteria: list[DataQualityCriterion] = Field(default_factory=list)


@dataclass(frozen=True, slots=True)
class DataQualityConfig:
    red_below: int = 50
    green_from: int = 80
    # Completeness state thresholds on the private point total (incomplete below `usable_from`).
    usable_from: int = 50
    rich_from: int = 75
    very_rich_from: int = 90
    # None = employment never counts as stale.
    stale_days: int | None = None

    @classmethod
    def from_settings(cls, settings: Settings) -> DataQualityConfig:
        return cls(
            red_below=settings.prospect_data_score_red_below,
            green_from=settings.prospect_data_score_green_from,
            usable_from=settings.prospect_completeness_usable_from,
            rich_from=settings.prospect_completeness_rich_from,
            very_rich_from=settings.prospect_completeness_very_rich_from,
            stale_days=settings.verification_stale_days,
        )


def band_of(total: int, config: DataQualityConfig) -> ScoreBand:
    if total < config.red_below:
        return ScoreBand.RED
    if total < config.green_from:
        return ScoreBand.YELLOW
    return ScoreBand.GREEN


def _status_of(points: int, max_points: int) -> CriterionStatus:
    if points >= max_points:
        return CriterionStatus.MET
    return CriterionStatus.PARTIAL if points > 0 else CriterionStatus.MISSING


def _criterion(
    id_: str, label: str, max_points: int, points: int, detail: str
) -> DataQualityCriterion:
    return DataQualityCriterion(
        id=id_,
        label=label,
        points=points,
        max_points=max_points,
        status=_status_of(points, max_points),
        detail=detail,
    )


def _is_verified(channel: Email | Phone) -> bool:
    return channel.verification_status == VerificationStatus.VERIFIED


def _email_criteria(
    emails: Sequence[Email], doubtful: Collection[str]
) -> list[DataQualityCriterion]:
    """`doubtful`: the addresses that look like someone else's (`email_identity`): one of them
    never counts as a verified e-mail."""
    active = sorted((email for email in emails if email.is_active), key=lambda email: str(email.id))
    primary = next((email for email in active if email.is_primary), None)
    checked = primary or (active[0] if active else None)
    has_active = bool(active)
    doubted = checked is not None and checked.address in doubtful
    verified = checked is not None and _is_verified(checked) and not doubted
    if checked is None:
        verified_detail = "Aucun e-mail à vérifier"
    elif doubted:
        verified_detail = "E-mail à vérifier (identité)"
    elif verified:
        verified_detail = "E-mail vérifié"
    elif checked.verification_status == VerificationStatus.INVALID:
        verified_detail = "E-mail signalé invalide"
    else:
        verified_detail = "E-mail non vérifié"
    return [
        _criterion(
            "email_active",
            "E-mail actif",
            20,
            20 if has_active else 0,
            "Un e-mail actif" if has_active else "Aucun e-mail actif",
        ),
        _criterion(
            "email_verified",
            "E-mail vérifié",
            20,
            20 if verified else 0,
            verified_detail,
        ),
    ]


def _phone_criteria(phones: Sequence[Phone]) -> list[DataQualityCriterion]:
    active = [phone for phone in phones if phone.is_active]
    verified = any(_is_verified(phone) for phone in active)
    return [
        _criterion(
            "phone_active",
            "Téléphone",
            10,
            10 if active else 0,
            "Un téléphone actif" if active else "Aucun téléphone actif",
        ),
        _criterion(
            "phone_verified",
            "Téléphone vérifié",
            5,
            5 if verified else 0,
            "Téléphone vérifié" if verified else "Aucun téléphone vérifié",
        ),
    ]


def _employment_criterion(
    verified_at: datetime | None, now: datetime, config: DataQualityConfig
) -> DataQualityCriterion:
    if verified_at is None:
        return _criterion("employment", "Emploi vérifié", 15, 0, "Emploi jamais vérifié")
    stale = config.stale_days is not None and now - verified_at > timedelta(days=config.stale_days)
    if stale:
        return _criterion(
            "employment",
            "Emploi vérifié",
            15,
            STALE_EMPLOYMENT_POINTS,
            f"Vérifié il y a plus de {config.stale_days} jours : à revérifier",
        )
    return _criterion("employment", "Emploi vérifié", 15, 15, "Emploi vérifié récemment")


def build_criteria(
    prospect: Prospect,
    now: datetime,
    config: DataQualityConfig,
    doubtful: Collection[str] = (),
) -> list[DataQualityCriterion]:
    known_activity = prospect.activity_status != ActivityStatus.UNKNOWN
    has_title = bool((prospect.exact_job_title or "").strip())
    return [
        *_email_criteria(prospect.emails, doubtful),
        *_phone_criteria(prospect.phones),
        _employment_criterion(prospect.employment_verified_at, now, config),
        _criterion(
            "activity",
            "Activité connue",
            5,
            5 if known_activity else 0,
            "Activité renseignée" if known_activity else "Activité inconnue",
        ),
        _criterion(
            "company",
            "Entreprise",
            10,
            10 if prospect.company_id is not None else 0,
            "Entreprise liée" if prospect.company_id is not None else "Aucune entreprise liée",
        ),
        _criterion(
            "role",
            "Rôle",
            10,
            10 if prospect.role_id is not None else 0,
            "Rôle renseigné" if prospect.role_id is not None else "Rôle non renseigné",
        ),
        _criterion(
            "job_title",
            "Intitulé exact",
            5,
            5 if has_title else 0,
            "Intitulé renseigné" if has_title else "Intitulé non renseigné",
        ),
    ]


def summarize(criteria: Sequence[DataQualityCriterion]) -> str:
    """Short factual sentence naming what is missing, or saying the record is complete."""
    missing = [item for item in criteria if item.points < item.max_points]
    if not missing:
        return "Fiche complète et vérifiée."
    names = ", ".join(item.label.lower() for item in missing[:3])
    more = (
        f" et {len(missing) - 3} autre{'s' if len(missing) - 3 > 1 else ''}"
        if len(missing) > 3
        else ""
    )
    return f"À compléter : {names}{more}."


def state_of(
    total: int, criteria: Sequence[DataQualityCriterion], config: DataQualityConfig
) -> CompletenessState:
    """Pure: the completeness state of a point total, gated on reachability."""
    reachable = any(
        item.points > 0 for item in criteria if item.id in ("email_active", "phone_active")
    )
    if not reachable or total < config.usable_from:
        return CompletenessState.INCOMPLETE
    if total < config.rich_from:
        return CompletenessState.USABLE
    if total < config.very_rich_from:
        return CompletenessState.RICH
    return CompletenessState.VERY_RICH


def build_data_quality(
    criteria: Sequence[DataQualityCriterion], config: DataQualityConfig
) -> DataQualityScore:
    """Pure: the score of a list of criteria under a configuration."""
    total = max(SCORE_MIN, min(SCORE_MAX, sum(item.points for item in criteria)))
    state = state_of(total, criteria, config)
    return DataQualityScore(
        state=state,
        state_label=STATE_LABELS[state],
        state_description=STATE_DESCRIPTIONS[state],
        total=total,
        band=band_of(total, config),
        summary=summarize(criteria),
        criteria=list(criteria),
    )


def data_quality_of(
    prospect: Prospect,
    now: datetime,
    config: DataQualityConfig,
    doubtful: Collection[str] = (),
) -> DataQualityScore:
    return build_data_quality(build_criteria(prospect, now, config, doubtful), config)
