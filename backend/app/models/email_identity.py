"""A person's word that an e-mail address really is someone's (migration 0064)."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import UUIDPrimaryKeyMixin


class EmailIdentityConfirmation(UUIDPrimaryKeyMixin, Base):
    """The explicit override of an identity doubt, for one (person, address): who and when.
    `person_key` is `prospect:<id>`, or `name:<folded name>` for a warehouse contact. A
    confirmation goes when the address leaves the prospect (a changed address asks again).
    Written and read by `app.services.email_identity` only."""

    __tablename__ = "email_identity_confirmations"
    __table_args__ = (UniqueConstraint("person_key", "address"),)

    prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    person_key: Mapped[str] = mapped_column(String(600))
    address: Mapped[str] = mapped_column(String(320))
    confirmed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    confirmed_by_id: Mapped[str | None] = mapped_column(String(128))
    confirmed_by_display: Mapped[str] = mapped_column(String(255))
