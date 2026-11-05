"""Application parameters edited in Paramètres (sequences rework): one row per known key.

The value is JSON so each key keeps its natural type; `app.services.app_settings` owns the keys,
their defaults and their validation. A missing row means the default.
"""

from typing import Any

from sqlalchemy import CheckConstraint, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin

MAX_FOLLOW_UPS_KEY = "contact.max_follow_ups"
CONTACT_CHART_DATE_KEYS = tuple(f"contact.chart.date_{slot}" for slot in range(5))
KNOWN_KEYS = (MAX_FOLLOW_UPS_KEY, *CONTACT_CHART_DATE_KEYS)


class AppSetting(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "app_settings"
    __table_args__ = (
        CheckConstraint(f"key IN ({', '.join(repr(key) for key in KNOWN_KEYS)})", name="known_key"),
    )

    key: Mapped[str] = mapped_column(String(64), unique=True)
    value: Mapped[Any] = mapped_column(JSONB)
