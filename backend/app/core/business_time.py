"""Circoe's business time zone: dates without time are stored at its midnight, and "today" (due
contacts, planned-contact weeks, the Home month) is its calendar day."""

from datetime import date, datetime, time
from zoneinfo import ZoneInfo

BUSINESS_TIMEZONE = ZoneInfo("Europe/Paris")


def start_of_day(day: date) -> datetime:
    """Midnight of `day` in business time (the start of that business day, DST-aware)."""
    return datetime.combine(day, time(), tzinfo=BUSINESS_TIMEZONE)


def business_moment(day: date, at: time) -> datetime:
    """`day` at the time of day `at` in business time (e.g. an appointment)."""
    return datetime.combine(day, at, tzinfo=BUSINESS_TIMEZONE)


def business_day(moment: datetime) -> date:
    """The calendar day of `moment` in business time."""
    return moment.astimezone(BUSINESS_TIMEZONE).date()
