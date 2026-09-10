"""Administrable taxonomies and Circoe internal referents (Settings, Task 06).

Rows are never deleted while referenced (FKs use RESTRICT); deactivate with `active = false`.
"""

from typing import Any

from sqlalchemy import CheckConstraint, Index, String, text, true
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin

SLUG_FORMAT = "slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'"
EMAIL_FORMAT = "email = lower(email) AND email ~ '^[^@\\s]+@[^@\\s]+$'"


def taxonomy_table_args(table: str) -> tuple[Any, ...]:
    return (
        CheckConstraint("btrim(label) <> ''", name="label_not_blank"),
        CheckConstraint(SLUG_FORMAT, name="slug_format"),
        # Case-insensitive label uniqueness, inactive rows included (reactivate, don't duplicate).
        Index(f"uq_{table}_lower_label", text("lower(label)"), unique=True),
    )


class TaxonomyMixin(UUIDPrimaryKeyMixin, TimestampMixin):
    label: Mapped[str] = mapped_column(String(255))
    # Stable machine key (lowercase, hyphenated); not rewritten on rename. Seeds match on it.
    slug: Mapped[str] = mapped_column(String(100), unique=True)
    active: Mapped[bool] = mapped_column(server_default=true())


class Role(TaxonomyMixin, Base):
    __tablename__ = "roles"
    __table_args__ = taxonomy_table_args(__tablename__)


class CommercialSegment(TaxonomyMixin, Base):
    __tablename__ = "commercial_segments"
    __table_args__ = taxonomy_table_args(__tablename__)


class ActivityCategory(TaxonomyMixin, Base):
    __tablename__ = "activity_categories"
    __table_args__ = taxonomy_table_args(__tablename__)


class InternalReferent(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A Circoe person who takes over a meeting/dossier. Not an application login account."""

    __tablename__ = "internal_referents"
    __table_args__ = (
        CheckConstraint(
            "btrim(first_name) <> '' AND btrim(last_name) <> ''", name="name_not_blank"
        ),
        CheckConstraint(EMAIL_FORMAT, name="email_format"),
    )

    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    email: Mapped[str | None] = mapped_column(String(320))
    active: Mapped[bool] = mapped_column(server_default=true())
