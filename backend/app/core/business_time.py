"""Circoe's business time zone: dates without time are stored at its midnight, and "today" (due
contacts, planned-contact weeks, the Home month) is its calendar day."""

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

BUSINESS_TIMEZONE = ZoneInfo("Europe/Paris")


def start_of_day(day: date) -> datetime:
    """Midnight of `day` in business time (the start of that business day, DST-aware)."""
    return datetime.combine(day, time(), tzinfo=BUSINESS_TIMEZONE)
