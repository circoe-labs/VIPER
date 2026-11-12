"""The mission telemetry tools of `/mcp`: an agent logs what it did and found, and may read or end
its **own** session. Contract: `doc/architecture/mission-telemetry.md` §5.6, §6, §11.

Sessions are opened by the claim, never by a tool: there is no register / log-off here. The
session, run, mission and agent of a log are derived server-side from `task_id` + `claim_id` and
the bearer token (`agent_missions.log_activity`); the client can name none of them. Nothing here
asks an agent to explain itself: the descriptions and schema ask for facts only (§6, enforced by
a conformance test). `mcp.py` calls `require(record, "tasks.work")` before each handler.
"""

import uuid
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.api.mcp_conversational import READ_ONLY_ANNOTATIONS
from app.api.mcp_missions import WRITE_ANNOTATIONS
from app.core.actor import ActorContext
from app.models.enums import MissionAgentLogEvent
from app.models.mission_telemetry import (
    LOG_MESSAGE_MAX_LENGTH,
    LOG_SOURCE_URL_MAX_LENGTH,
    MissionAgentSession,
)
from app.services import agent_missions, mission_telemetry
from app.services.errors import InvalidFieldError

CAPABILITY = "tasks.work"
_UUID = {"type": "string", "format": "uuid"}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "viper_log_mission_activity",
        "description": (
            "Log one fact about the mission task you hold: a search you ran, a source you "
            "opened, something you observed or verified, progress, a warning or an error, or the "
            "outcome of a choice with its evidence. One short factual sentence in French, past "
            "tense, plain text. Facts only: what you did and what you found. Never invent a "
            "source_published_at: omit it unless the page states a date. Your work session is "
            "opened automatically by the claim; this call lands in it and keeps it alive. "
            "Needs task_id and claim_id like a heartbeat. Limit: 120 logs per minute; a refused "
            "log is not fatal, keep working."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_id": _UUID,
                "claim_id": _UUID,
                "event_type": {
                    "type": "string",
                    "enum": [event.value for event in MissionAgentLogEvent],
                    "description": (
                        "search | source_opened | observation | verification | progress | "
                        "warning | error | decision_summary."
                    ),
                },
                "message": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": LOG_MESSAGE_MAX_LENGTH,
                    "description": "The fact, one sentence.",
                },
                "source_url": {
                    "type": "string",
                    "maxLength": LOG_SOURCE_URL_MAX_LENGTH,
                    "description": "http(s) URL of the source, when there is one.",
                },
                "source_published_at": {
                    "type": "string",
                    "description": "ISO date or date-time the source itself states; else omit.",
                },
                "metadata": {
                    "type": "object",
                    "description": (
                        "Optional structured facts: query, engine, results_count, field, "
                        "outcome (confirmed | contradicted | not_found), done, total, reason, "
                        "code. At most 4 KB."
                    ),
                },
            },
            "required": ["task_id", "claim_id", "event_type", "message"],
            "additionalProperties": False,
        },
        "annotations": WRITE_ANNOTATIONS,
    },
    {
        "name": "viper_end_mission_session",
        "description": (
            "Optional courtesy: end your own work session on the run of this mission task, so "
            "the Activity tab shows you as finished. Not required: an idle session closes by "
            "itself after 3 hours. Releases or fails nothing; safe to repeat."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"task_id": _UUID},
            "required": ["task_id"],
            "additionalProperties": False,
        },
        "annotations": WRITE_ANNOTATIONS,
    },
    {
        "name": "viper_get_mission_session",
        "description": (
            "Read your own work session on the run of this mission task: status, start, last "
            "activity, end and why, and how many logs it holds. Use it to learn that your "
            "session timed out. Does not touch the session; other agents' sessions are never "
            "shown."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"task_id": _UUID},
            "required": ["task_id"],
            "additionalProperties": False,
        },
        "annotations": READ_ONLY_ANNOTATIONS,
    },
]


def _uuid(args: dict[str, Any], name: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(args.get(name)))
    except (TypeError, ValueError) as error:
        raise InvalidFieldError(name, "Expected a UUID.", "format") from error


def _text(args: dict[str, Any], name: str, *, required: bool = False) -> str | None:
    value = args.get(name)
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise InvalidFieldError(name, "Expected a string.", "format")
    return value


def _published_at(args: dict[str, Any]) -> datetime | None:
    raw = _text(args, "source_published_at")
    if raw is None:
        return None
    try:
        if "T" in raw or " " in raw:
            parsed = datetime.fromisoformat(raw)
        else:
            parsed = datetime.combine(date.fromisoformat(raw), datetime.min.time())
    except ValueError as error:
        raise InvalidFieldError(
            "source_published_at", "Expected an ISO date or date-time.", "format"
        ) from error
    # A bare date is midnight UTC: the column is a timestamp, the date is all the source stated.
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _session_body(row: MissionAgentSession, logs_count: int) -> dict[str, Any]:
    return {
        "session_id": str(row.id),
        "status": row.status.value,
        "started_at": row.started_at.isoformat(),
        "last_seen_at": row.last_seen_at.isoformat(),
        "ended_at": row.ended_at.isoformat() if row.ended_at else None,
        "disconnect_reason": row.disconnect_reason.value if row.disconnect_reason else None,
        "logs_count": logs_count,
    }


def log_mission_activity(
    session: Session, actor: ActorContext, args: dict[str, Any]
) -> dict[str, Any]:
    metadata = args.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        raise InvalidFieldError("metadata", "Expected an object.", "format")
    log = agent_missions.log_activity(
        session,
        actor,
        _uuid(args, "task_id"),
        _uuid(args, "claim_id"),
        _text(args, "event_type", required=True) or "",
        _text(args, "message", required=True) or "",
        source_url=_text(args, "source_url"),
        source_published_at=_published_at(args),
        metadata=metadata,
    )
    return {
        "log_id": str(log.id),
        "session_id": str(log.session_id),
        "created_at": log.created_at.isoformat(),
    }


def end_mission_session(
    session: Session, actor: ActorContext, args: dict[str, Any]
) -> dict[str, Any]:
    row = mission_telemetry.end_own_session(session, actor, _uuid(args, "task_id"))
    return {
        "session_id": str(row.id),
        "status": row.status.value,
        "ended_at": row.ended_at.isoformat() if row.ended_at else None,
    }


def get_mission_session(
    session: Session, actor: ActorContext, args: dict[str, Any]
) -> dict[str, Any]:
    row, count = mission_telemetry.own_session_of_task(session, actor, _uuid(args, "task_id"))
    return _session_body(row, count)
