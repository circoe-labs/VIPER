"""Login accounts and their server-side sessions (Task 04, ADR-0004).

A `User` is someone who signs in to VIPER. It is unrelated to `InternalReferent` (a Circoe person
named on a dossier): neither table references the other. V1 has no roles; every account has the
same rights.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.common import EMAIL_FORMAT, TimestampMixin, UUIDPrimaryKeyMixin


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(EMAIL_FORMAT, name="email_format"),
        CheckConstraint("btrim(display_name) <> ''", name="display_name_not_blank"),
    )

    # Sign-in identifier, stored lowercase.
    email: Mapped[str] = mapped_column(String(320), unique=True)
    # Shown in the header and snapshotted as `actor_display` on history/audit rows.
    display_name: Mapped[str] = mapped_column(String(255))
    # argon2id PHC string. Never serialized or logged; only `app.core.security` reads it.
    password_hash: Mapped[str] = mapped_column(String(255))


class UserSession(UUIDPrimaryKeyMixin, Base):
    """One signed-in browser. Only the SHA-256 of the cookie token is stored."""

    __tablename__ = "user_sessions"
    __table_args__ = (CheckConstraint("token_hash ~ '^[0-9a-f]{64}$'", name="token_hash_format"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Idle expiry is measured from here (bumped at most once a minute).
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Absolute expiry, fixed at sign-in.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(lazy="joined")
