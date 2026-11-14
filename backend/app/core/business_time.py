"""Circoe's business time zone: dates without time are stored at its midnight, and "today" (due
contacts, planned-contact weeks, the Home month) is its calendar day."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
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


@dataclass(frozen=True, slots=True)
class BusinessWeek:
    """« Cette semaine »: the calendar week Monday 00:00 (inclusive) to next Monday 00:00
    (exclusive) in business time (Europe/Paris, DST-aware: 167 to 169 real hours). The one
    definition shared by every weekly counter (Home, Prospection, Contact):
    doc/features/weekly-metrics.md."""

    monday: date

    @classmethod
    def of(cls, day: date) -> BusinessWeek:
        return cls(monday=day - timedelta(days=day.weekday()))

    @property
    def sunday(self) -> date:
        return self.monday + timedelta(days=6)

    @property
    def start(self) -> datetime:
        return start_of_day(self.monday)

    @property
    def end(self) -> datetime:
        """Start of the next Monday (exclusive)."""
        return start_of_day(self.monday + timedelta(days=7))

    @property
    def label(self) -> str:
        """ISO week label, e.g. `2026-W43`."""
        year, number, _ = self.monday.isocalendar()
        return f"{year}-W{number:02d}"
