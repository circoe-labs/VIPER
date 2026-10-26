"""Application parameters edited in Paramètres (sequences rework): today « max relances » (D2).

`app_settings` holds one row per key; a missing row means the default. Only a person changes a
parameter (403 `human_actor_required` otherwise); the change is audited (`app_setting.created` or
`.updated`, with the before/after value). Operations flush; the caller owns the transaction.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import AppSetting
from app.models.app_settings import MAX_FOLLOW_UPS_KEY
from app.services import audit
from app.services.contact_workflow import DEFAULT_MAX_FOLLOW_UPS, MAX_FOLLOW_UPS_LIMIT
from app.services.errors import ActorNotAllowedError, InvalidFieldError


def _row(session: Session, key: str, *, lock: bool = False) -> AppSetting | None:
    statement = select(AppSetting).where(AppSetting.key == key)
    return session.scalar(statement.with_for_update() if lock else statement)


def max_follow_ups(session: Session) -> int:
    """« Max relances »: after R<max> is sent, the sequence is « Relance terminée »."""
    row = _row(session, MAX_FOLLOW_UPS_KEY)
    value = row.value if row is not None else None
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return DEFAULT_MAX_FOLLOW_UPS


def set_max_follow_ups(session: Session, actor: ActorContext, value: int) -> int:
    """Set « max relances » (0 … `MAX_FOLLOW_UPS_LIMIT`); 422 `invalid` with reason `out_of_range`
    otherwise. Returns the stored value."""
    if actor.type is not ActorType.HUMAN:
        raise ActorNotAllowedError("A parameter is changed by a person.")
    if not 0 <= value <= MAX_FOLLOW_UPS_LIMIT:
        raise InvalidFieldError(
            "max_follow_ups",
            f"Expected a number of follow-ups between 0 and {MAX_FOLLOW_UPS_LIMIT}.",
            "out_of_range",
        )
    row = _row(session, MAX_FOLLOW_UPS_KEY, lock=True)
    if row is None:
        row = AppSetting(key=MAX_FOLLOW_UPS_KEY, value=value)
        audit.annotate(session, actor, row)
        session.add(row)
    elif row.value != value:
        audit.annotate(session, actor, row)
        row.value = value
    session.flush()
    return value
