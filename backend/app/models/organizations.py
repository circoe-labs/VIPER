"""Organisations, the roles of their members, and who owns the data.

An `Organization` is a customer company using VIPER. CIRCOE is the first one and owns every
record created so far: the root business tables carry an `organization_id`
(`OrganizationOwnedMixin`) defaulting to CIRCOE in the database itself, so no insert path can
leave a row without an owner.
Child rows (a company's establishments, a prospect's e-mails…) belong to their parent's owner.

While only CIRCOE signs in (development phase, `doc/architecture/organizations.md`), reads are not
filtered per organisation yet: the sign-in refuses a member of any other organisation, which keeps
the data isolated until those filters exist.
"""

import uuid
from enum import StrEnum

from sqlalchemy import CheckConstraint, ForeignKey, String, Uuid, text
from sqlalchemy.orm import Mapped, declared_attr, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin

# Fixed so the migration, the column defaults and the code name the same row.
CIRCOE_ORGANIZATION_ID = uuid.UUID("01a00000-0000-7000-8000-00000000c1c0")
CIRCOE_NAME = "CIRCOE"
NAME_MAX_LENGTH = 120


class OrganizationRole(StrEnum):
    """What a member may do in « Organisation » (the platform admin is a separate flag)."""

    ADMIN = "admin"
    MANAGER = "manager"
    MEMBER = "member"


class Organization(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "organizations"
    __table_args__ = (
        CheckConstraint(
            f"btrim(name) <> '' AND char_length(name) <= {NAME_MAX_LENGTH}", name="name_valid"
        ),
        CheckConstraint(
            "email_domain IS NULL OR email_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'",
            name="email_domain_format",
        ),
    )

    name: Mapped[str] = mapped_column(String(NAME_MAX_LENGTH), unique=True)
    # A first Infomaniak sign-in with an address of this domain joins the organisation as a
    # member (CIRCOE: `circoe.com`). Unset: members are only added from « Organisation ».
    email_domain: Mapped[str | None] = mapped_column(String(255), unique=True)


class OrganizationOwnedMixin:
    """`organization_id` of a root business table: CIRCOE unless the code says otherwise."""

    @declared_attr
    def organization_id(cls) -> Mapped[uuid.UUID]:
        return mapped_column(
            Uuid,
            ForeignKey("organizations.id", ondelete="RESTRICT"),
            index=True,
            server_default=text(f"'{CIRCOE_ORGANIZATION_ID}'::uuid"),
        )
