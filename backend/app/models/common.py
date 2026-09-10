"""Column conventions shared by the ORM models (ADR-0002)."""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, Enum, FetchedValue, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

ENUM_LENGTH = 32
# CHECK for an `email` column: stored lowercase, one `@` between non-blank parts.
EMAIL_FORMAT = "email = lower(email) AND email ~ '^[^@\\s]+@[^@\\s]+$'"


def text_enum(enum_cls: type[StrEnum], name: str) -> Enum:
    """`varchar(32)` + CHECK constraint `ck_<table>_<name>`; pass the column name as `name`."""
    return Enum(
        enum_cls,
        name=name,
        native_enum=False,
        create_constraint=True,
        length=ENUM_LENGTH,
        values_callable=lambda cls: [member.value for member in cls],
        validate_strings=True,
    )


class UUIDPrimaryKeyMixin:
    # Application inserts get time-ordered UUIDv7; raw SQL inserts fall back to gen_random_uuid().
    id: Mapped[uuid.UUID] = mapped_column(
        Uuid,
        primary_key=True,
        default=uuid.uuid7,
        server_default=func.gen_random_uuid(),
        sort_order=-1,
    )


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), sort_order=1
    )
    # Maintained by the `set_updated_at` trigger, so raw SQL writes are covered too.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        server_onupdate=FetchedValue(),
        sort_order=1,
    )
