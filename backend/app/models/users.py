"""Login accounts and their server-side sessions (Task 04, ADR-0004).

A `User` is someone who signs in to VIPER. It is unrelated to `InternalReferent` (a Circoe person
named on a dossier): neither table references the other.

Each account belongs to one organisation with a role (admin, manager, member: what it may do in
« Organisation »). One account at most is the platform admin (`is_superadmin`): it creates the
organisations and manages every member. People sign in with their Infomaniak account
(`infomaniak_sub`); the password is only the local-development fallback.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, String, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.common import EMAIL_FORMAT, TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.organizations import CIRCOE_ORGANIZATION_ID, Organization, OrganizationRole


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(EMAIL_FORMAT, name="email_format"),
        CheckConstraint("btrim(display_name) <> ''", name="display_name_not_blank"),
        # « Un compte admin unique »: at most one platform admin.
        Index(
            "uq_users_single_superadmin",
            "is_superadmin",
            unique=True,
            postgresql_where=text("is_superadmin"),
        ),
    )

    # Sign-in identifier, stored lowercase.
    email: Mapped[str] = mapped_column(String(320), unique=True)
    # Shown in the header and snapshotted as `actor_display` on history/audit rows.
    display_name: Mapped[str] = mapped_column(String(255))
    # argon2id PHC string. Never serialized or logged; only `app.core.security` reads it. None for
    # an account that only signs in with Infomaniak.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    organization_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("organizations.id", ondelete="RESTRICT"),
        index=True,
        server_default=text(f"'{CIRCOE_ORGANIZATION_ID}'::uuid"),
    )
    role: Mapped[OrganizationRole] = mapped_column(
        text_enum(OrganizationRole, "role"), server_default=OrganizationRole.MEMBER.value
    )
    is_superadmin: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # A deactivated account cannot sign in; its sessions were revoked when it was deactivated.
    is_active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    # The Infomaniak account (`sub` claim) bound at the first Infomaniak sign-in.
    infomaniak_sub: Mapped[str | None] = mapped_column(String(255), unique=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    organization: Mapped[Organization] = relationship(lazy="joined")


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
