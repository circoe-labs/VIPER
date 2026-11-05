"""Data-quality score of a prospect (« Qualité de la fiche »): how reachable and how trustworthy the
record is, computed on the backend from the record itself.

It is independent of the interest score (`app.services.prospect_score`, manual, from notes): the
two answer different questions and are displayed side by side. Each criterion is worth fixed
points (the maximums add up to 100); a criterion is met in full, partly or not at all, and the
breakdown says which, so the UI only displays it. Never stored, computed on read.

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

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Settings
from app.models.enums import ActivityStatus, VerificationStatus
from app.models.prospects import Email, Phone, Prospect
from app.services.prospect_score import SCORE_MAX, SCORE_MIN, ScoreBand

STALE_EMPLOYMENT_POINTS = 8


class DataQualityCriterion(BaseModel):
    """One line of the breakdown: `Téléphone vérifié — 0/5`."""

    model_config = ConfigDict(frozen=True)

    id: str
    label: str
    points: int
    max_points: int
    # Short French explanation of what was found (« Aucun e-mail actif »).
    detail: str


class DataQualityScore(BaseModel):
    model_config = ConfigDict(frozen=True)

    total: int = Field(ge=SCORE_MIN, le=SCORE_MAX)
    band: ScoreBand
    summary: str
    criteria: list[DataQualityCriterion] = Field(default_factory=list)


@dataclass(frozen=True, slots=True)
class DataQualityConfig:
    red_below: int = 50
    green_from: int = 80
    # None = employment never counts as stale.
    stale_days: int | None = None

    @classmethod
    def from_settings(cls, settings: Settings) -> DataQualityConfig:
        return cls(
            red_below=settings.prospect_data_score_red_below,
            green_from=settings.prospect_data_score_green_from,
            stale_days=settings.verification_stale_days,
        )


def band_of(total: int, config: DataQualityConfig) -> ScoreBand:
    if total < config.red_below:
        return ScoreBand.RED
    if total < config.green_from:
        return ScoreBand.YELLOW
    return ScoreBand.GREEN


def _criterion(
    id_: str, label: str, max_points: int, points: int, detail: str
) -> DataQualityCriterion:
    return DataQualityCriterion(
        id=id_, label=label, points=points, max_points=max_points, detail=detail
    )


def _is_verified(channel: Email | Phone) -> bool:
    return channel.verification_status == VerificationStatus.VERIFIED


def _email_criteria(emails: Sequence[Email]) -> list[DataQualityCriterion]:
    active = sorted((email for email in emails if email.is_active), key=lambda email: str(email.id))
    primary = next((email for email in active if email.is_primary), None)
    checked = primary or (active[0] if active else None)
    has_active = bool(active)
    if checked is None:
        verified_detail = "Aucun e-mail à vérifier"
    elif _is_verified(checked):
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
            20 if checked is not None and _is_verified(checked) else 0,
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
    prospect: Prospect, now: datetime, config: DataQualityConfig
) -> list[DataQualityCriterion]:
    known_activity = prospect.activity_status != ActivityStatus.UNKNOWN
    has_title = bool((prospect.exact_job_title or "").strip())
    return [
        *_email_criteria(prospect.emails),
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


def build_data_quality(
    criteria: Sequence[DataQualityCriterion], config: DataQualityConfig
) -> DataQualityScore:
    """Pure: the score of a list of criteria under a configuration."""
    total = max(SCORE_MIN, min(SCORE_MAX, sum(item.points for item in criteria)))
    return DataQualityScore(
        total=total,
        band=band_of(total, config),
        summary=summarize(criteria),
        criteria=list(criteria),
    )


def data_quality_of(
    prospect: Prospect, now: datetime, config: DataQualityConfig
) -> DataQualityScore:
    return build_data_quality(build_criteria(prospect, now, config), config)
