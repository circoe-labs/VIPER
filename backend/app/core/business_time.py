"""Circoe's business time zone: dates without time are stored at its midnight, and "today" (due
contacts, planned-contact weeks) is its calendar day."""

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

BUSINESS_TIMEZONE = ZoneInfo("Europe/Paris")


def business_day(moment: datetime) -> date:
    """The calendar day of `moment` in business time."""
    return moment.astimezone(BUSINESS_TIMEZONE).date()


def business_moment(day: date, at: time | None = None) -> datetime:
    """`day` at `at` (midnight by default) in business time."""
    return datetime.combine(day, at or time(), tzinfo=BUSINESS_TIMEZONE)
