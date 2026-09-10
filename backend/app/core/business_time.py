"""Circoe's business time zone: dates without time are stored at its midnight, and "today" (due
contacts, planned-contact weeks) is its calendar day."""

from zoneinfo import ZoneInfo

BUSINESS_TIMEZONE = ZoneInfo("Europe/Paris")
