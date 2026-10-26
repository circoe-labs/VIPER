"""Calendly client and appointment sync (Agenda).

VIPER reads Calendly with a personal access token (Paramètres > Connexions), by polling: nothing
needs a public address. `GET /users/me` tells who the token belongs to and the organization;
`GET /scheduled_events` lists the events of the whole organization when the token may see it (an
owner or admin), else only the token owner's; `GET {event}/invitees` gives who booked.

A sync only ever *reads* Calendly. Per event it creates the appointment, or refreshes what Calendly
owns (title, invitee, host, location) and a cancellation; what people decided in VIPER (status,
referent, notes, a date moved by hand) is never overwritten. A Calendly reschedule is a new event
and a cancelled one carrying `rescheduled`: the old row is dropped and the new one counts the move.
The token never reaches a log line or an error message.
"""

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx2
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Appointment, Company, ContactTracking, Email, InternalReferent, Prospect
from app.models.enums import AppointmentSource, AppointmentStatus

logger = logging.getLogger(__name__)

API_BASE = "https://api.calendly.com"
TIMEOUT_SECONDS = 20.0
PAGE_SIZE = 100
# The sync window around now: recent meetings (to follow up) and the next months.
LOOKBACK = timedelta(days=30)
LOOKAHEAD = timedelta(days=180)
COMPANY_QUESTION = re.compile(r"entreprise|soci[ée]t[ée]|company|organi[sz]ation", re.IGNORECASE)


class CalendlyError(Exception):
    """A Calendly call failed; `code` is a stable key the UI words (never the token)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SyncReport:
    created: int = 0
    updated: int = 0
    cancelled: int = 0


class CalendlyClient:
    def __init__(
        self,
        token: str,
        *,
        base_url: str = API_BASE,
        transport: httpx2.BaseTransport | None = None,
        trust_env: bool = False,
    ) -> None:
        self._token = token
        self._base_url = base_url.rstrip("/")
        self._transport = transport
        self._trust_env = trust_env

    def _get(self, client: httpx2.Client, url: str, params: dict[str, Any] | None = None) -> Any:
        try:
            response = client.get(
                url, params=params, headers={"Authorization": f"Bearer {self._token}"}
            )
        except httpx2.TimeoutException:
            raise CalendlyError(
                "calendly_unreachable", "Calendly did not answer in time."
            ) from None
        except httpx2.TransportError:
            raise CalendlyError("calendly_unreachable", "Calendly cannot be reached.") from None
        if response.status_code in (401, 403):
            raise CalendlyError("calendly_unauthorized", "Calendly refused the access token.")
        if response.status_code == 429:
            raise CalendlyError("calendly_rate_limited", "Calendly is rate limiting this token.")
        if response.status_code >= 400:
            raise CalendlyError(
                "calendly_unreachable", f"Calendly answered {response.status_code}."
            )
        try:
            return response.json()
        except ValueError:
            raise CalendlyError("calendly_unreachable", "Calendly answered unreadably.") from None

    def _http(self) -> httpx2.Client:
        return httpx2.Client(
            timeout=httpx2.Timeout(TIMEOUT_SECONDS),
            transport=self._transport,
            trust_env=self._trust_env,
        )

    def me(self) -> dict[str, Any]:
        """The token owner (`name`, `email`, `uri`, `current_organization`): « Tester »."""
        with self._http() as client:
            payload = self._get(client, f"{self._base_url}/users/me")
        resource = payload.get("resource") if isinstance(payload, dict) else None
        if not isinstance(resource, dict):
            raise CalendlyError("calendly_unreachable", "Calendly answered unreadably.")
        return resource

    def events_with_invitees(
        self, start: datetime, end: datetime
    ) -> list[tuple[dict[str, Any], list[dict[str, Any]]]]:
        """Every event starting in the window, each with its invitees (active and cancelled)."""
        with self._http() as client:
            me = self._get(client, f"{self._base_url}/users/me").get("resource", {})
            scope = {"organization": me.get("current_organization")}
            try:
                events = self._events(client, scope, start, end)
            except CalendlyError as error:
                if error.code != "calendly_unauthorized" or not me.get("uri"):
                    raise
                # Not an owner/admin: the token's own calendar only.
                events = self._events(client, {"user": me["uri"]}, start, end)
            return [(event, self._invitees(client, event)) for event in events]

    def _events(
        self, client: httpx2.Client, scope: dict[str, Any], start: datetime, end: datetime
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            **scope,
            "min_start_time": start.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000000Z"),
            "max_start_time": end.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000000Z"),
            "count": PAGE_SIZE,
            "sort": "start_time:asc",
        }
        collected: list[dict[str, Any]] = []
        while True:
            payload = self._get(client, f"{self._base_url}/scheduled_events", params)
            collected.extend(payload.get("collection", []))
            token = (payload.get("pagination") or {}).get("next_page_token")
            if not token:
                return collected
            params = {**params, "page_token": token}

    def _invitees(self, client: httpx2.Client, event: dict[str, Any]) -> list[dict[str, Any]]:
        uri = str(event.get("uri", ""))
        if not uri.startswith(self._base_url):
            return []
        payload = self._get(client, f"{uri}/invitees", {"count": PAGE_SIZE})
        invitees = payload.get("collection", [])
        return invitees if isinstance(invitees, list) else []


def _moment(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _location(event: dict[str, Any]) -> str | None:
    place = event.get("location")
    if not isinstance(place, dict):
        return None
    value = place.get("join_url") or place.get("location")
    return str(value)[:1000] if value else None


def _company_answer(invitee: dict[str, Any]) -> str | None:
    for item in invitee.get("questions_and_answers") or []:
        if isinstance(item, dict) and COMPANY_QUESTION.search(str(item.get("question", ""))):
            answer = str(item.get("answer", "")).strip()
            if answer:
                return answer[:300]
    return None


def _clip(value: Any, limit: int) -> str | None:
    return str(value).strip()[:limit] or None if value else None


def sync_appointments(
    session: Session,
    client: CalendlyClient,
    *,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> SyncReport:
    """Reads Calendly and brings the `appointments` table up to date. Idempotent."""
    moment = now()
    fetched = client.events_with_invitees(moment - LOOKBACK, moment + LOOKAHEAD)
    created = updated = cancelled = 0
    for event, invitees in fetched:
        invitee = next((item for item in invitees if item.get("status") == "active"), None)
        event_uri = _clip(event.get("uri"), 300)
        starts, ends = _moment(event.get("start_time")), _moment(event.get("end_time"))
        if event_uri is None or starts is None or ends is None:
            continue
        row = session.scalar(select(Appointment).where(Appointment.calendly_event_uri == event_uri))
        canceled = event.get("status") == "canceled"
        if canceled:
            old = invitee or (invitees[0] if invitees else {})
            if old.get("rescheduled"):
                # The meeting moved: its new event carries it on. The old row is not a cancellation.
                if row is not None:
                    session.delete(row)
                continue
            if row is not None and row.status is AppointmentStatus.SCHEDULED:
                row.status = AppointmentStatus.CANCELLED
                cancelled += 1
            continue
        if invitee is None:
            continue
        memberships = event.get("event_memberships") or [{}]
        host = memberships[0] if isinstance(memberships[0], dict) else {}
        fields = {
            "calendly_invitee_uri": _clip(invitee.get("uri"), 300),
            "title": _clip(event.get("name"), 300) or "Rendez-vous",
            "invitee_name": _clip(invitee.get("name"), 300) or "Invité",
            "invitee_email": _clip(invitee.get("email"), 320),
            "host_name": _clip(host.get("user_name"), 300),
            "host_email": _clip(host.get("user_email"), 320),
            "location": _location(event),
        }
        if row is None:
            row = Appointment(
                source=AppointmentSource.CALENDLY,
                calendly_event_uri=event_uri,
                starts_at=starts,
                ends_at=ends,
                status=AppointmentStatus.SCHEDULED,
                reschedule_count=1 if invitee.get("old_invitee") else 0,
                **fields,
            )
            link_prospect(session, row, company_hint=_company_answer(invitee))
            session.add(row)
            created += 1
        elif any(getattr(row, name) != value for name, value in fields.items()):
            for name, value in fields.items():
                setattr(row, name, value)
            updated += 1
    session.flush()
    logger.info("calendly.sync created=%s updated=%s cancelled=%s", created, updated, cancelled)
    return SyncReport(created=created, updated=updated, cancelled=cancelled)


def link_prospect(session: Session, row: Appointment, *, company_hint: str | None = None) -> None:
    """Ties a new appointment to the prospect who owns the invitee's address, to the company that
    prospect works for, and to the internal referent (the Calendly host first, else the prospect's
    own referent). Anything not found stays empty: the Agenda shows what Calendly gave."""
    if row.invitee_email:
        prospect = session.scalar(
            select(Prospect)
            .join(Email, Email.prospect_id == Prospect.id)
            .where(Email.address == row.invitee_email.lower(), Email.is_active)
            .limit(1)
        )
        if prospect is not None:
            row.prospect_id = prospect.id
            company = session.get(Company, prospect.company_id) if prospect.company_id else None
            if company is not None:
                row.company_name = company.display_name[:300]
            if row.referent_id is None:
                tracking = session.scalar(
                    select(ContactTracking).where(ContactTracking.prospect_id == prospect.id)
                )
                row.referent_id = tracking.referent_id if tracking is not None else None
    if row.company_name is None:
        row.company_name = company_hint
    if row.host_email:
        host = session.scalar(
            select(InternalReferent).where(
                InternalReferent.email == row.host_email.lower(), InternalReferent.active
            )
        )
        if host is not None:
            row.referent_id = host.id
