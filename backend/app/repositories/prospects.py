"""Prospect persistence, including the only write path allowed to clear a do-not-contact status."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.enums import ContactabilityStatus
from app.models.prospects import Prospect

# Transaction-local setting read by the `guard_do_not_contact` trigger (migration 0002).
CONTACTABILITY_CLEAR_SETTING = "viper.allow_contactability_clear"


def get_prospect(session: Session, prospect_id: uuid.UUID) -> Prospect | None:
    return session.get(Prospect, prospect_id)


def write_cleared_contactability(session: Session, prospect: Prospect) -> None:
    """Flush `prospect` back to contactable while the trigger's clearing flag is on.

    The flag is transaction-local and switched off right after; a failed flush rolls it back
    with the transaction.
    """
    session.execute(select(func.set_config(CONTACTABILITY_CLEAR_SETTING, "on", True)))
    prospect.contactability_status = ContactabilityStatus.CONTACTABLE
    prospect.do_not_contact_at = None
    prospect.do_not_contact_reason = None
    session.flush()
    session.execute(select(func.set_config(CONTACTABILITY_CLEAR_SETTING, "off", True)))
