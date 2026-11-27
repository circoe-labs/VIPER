"""Voice mission assistant API (`/api/missions/assistant`), task
`viper_mission_agent_configuration_v2`, Slice 06. Contract: `doc/architecture/missions.md` §7f.

Nothing here creates or edits a mission: `turn` answers with the assistant's sentence and the draft
edits it proposes, and the browser lays them over the same form the person types in; the mission is
created, if at all, by the form's own `POST /api/missions`.

- `GET  /capabilities` which parts are usable now (`assistant`: the OpenAI key + model are set;
  `speech`: a Whisper-compatible service is configured), so the UI can degrade before the person
  speaks;
- `POST /turn`        one conversational turn: `{messages, draft}` → `{reply, actions, finalize}`;
- `POST /transcribe`  optional server-side speech-to-text of one utterance (multipart `audio`).
"""

import logging
import time
from typing import Any, Literal

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors, refusal
from app.core.config import Settings
from app.services import mission_assistant, speech_to_text
from app.services import mission_creator_prompt as creator_prompt
from app.services.assistant_llm import assistant_model_for
from app.services.mail_generation.openai_client import config_from_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/missions/assistant", tags=["mission-assistant"])

MAX_AUDIO_FORM_OVERHEAD = 64 * 1024


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CapabilitiesOut(BaseModel):
    assistant: bool
    speech: bool


class RecordIn(StrictModel):
    kind: Literal["company", "prospect", "warehouse"]
    id: str = Field(max_length=64)
    label: str | None = Field(default=None, max_length=300)
    hint: str | None = Field(default=None, max_length=300)


class DraftSnapshot(StrictModel):
    """The form's state as the browser sees it (`frontend/src/missions/voice/draftSnapshot.ts`).
    `null` for `prompt` / `skill_ids` / `source_ids` = follows the category."""

    name: str = Field(default="", max_length=200)
    category_id: str | None = Field(default=None, max_length=64)
    category_name: str | None = Field(default=None, max_length=200)
    result_kind: str | None = Field(default=None, max_length=40)
    prompt: str | None = Field(default=None, max_length=5000)
    skill_ids: list[str] | None = Field(default=None, max_length=100)
    source_ids: list[str] | None = Field(default=None, max_length=100)
    targets: list[RecordIn] = Field(default_factory=list, max_length=500)
    context_refs: list[RecordIn] = Field(default_factory=list, max_length=50)
    recurring: bool = False
    interval_count: int = 24
    interval_unit: str = "hours"
    starts_at: str = ""
    end_kind: str = "never"
    ends_at: str = ""
    max_runs: int | None = None
    task_count: int = 1
    geography: str = Field(default="", max_length=200)
    period_days: int | None = None
    exclude_known: bool = False
    # What the form still lacks before it can be saved (its own sentence), null when ready.
    missing: str | None = Field(default=None, max_length=300)


class MessageIn(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=mission_assistant.MAX_MESSAGE_LENGTH)


class TurnIn(StrictModel):
    messages: list[MessageIn] = Field(min_length=1, max_length=60)
    draft: DraftSnapshot


class ActionOut(BaseModel):
    tool: str
    args: dict[str, Any]
    summary: str


class TurnOut(BaseModel):
    reply: str
    actions: list[ActionOut]
    # The assistant asks to create: the browser goes through the form's own validation and save.
    finalize: bool
    model: str


@router.get("/capabilities")
def capabilities(request: Request) -> CapabilitiesOut:
    settings: Settings = request.app.state.settings
    return CapabilitiesOut(
        assistant=config_from_settings(settings) is not None,
        speech=speech_to_text.available(settings),
    )


@router.post("/turn")
def turn(body: TurnIn, request: Request, session: SessionDep, actor: CurrentActor) -> TurnOut:
    if body.messages[-1].role != "user":
        raise refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "invalid_request",
            "The last message must be the person's.",
        )
    settings: Settings = request.app.state.settings
    started = time.monotonic()
    with business_errors():
        model = assistant_model_for(settings, request.app.state.openai_transport)
        result = mission_assistant.run_turn(
            session,
            model,
            creator_prompt=creator_prompt.mission_creator_prompt(settings),
            messages=[message.model_dump() for message in body.messages],
            draft=body.draft.model_dump(),
        )
    logger.info(
        "mission_assistant.turn_ok by=%s elapsed_ms=%s tool_calls=%s",
        actor.id,
        round((time.monotonic() - started) * 1000),
        result.tool_calls,
    )
    return TurnOut(
        reply=result.reply,
        actions=[ActionOut(tool=a.tool, args=a.args, summary=a.summary) for a in result.actions],
        finalize=result.finalize,
        model=result.model,
    )


class TranscriptOut(BaseModel):
    text: str


@router.post("/transcribe")
async def transcribe(request: Request) -> TranscriptOut:
    settings: Settings = request.app.state.settings
    if not speech_to_text.available(settings):
        raise refusal(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "stt_not_configured",
            "No speech-to-text service is configured.",
        )
    length = request.headers.get("content-length")
    if length is None or not length.isdigit():
        raise refusal(status.HTTP_411_LENGTH_REQUIRED, "length_required", "Content-Length needed.")
    if int(length) > speech_to_text.MAX_AUDIO_BYTES + MAX_AUDIO_FORM_OVERHEAD:
        raise refusal(
            status.HTTP_413_CONTENT_TOO_LARGE, "stt_invalid_audio", "The recording is too long."
        )
    async with request.form(max_files=1, max_fields=2) as form:
        upload = form.get("audio")
        if not isinstance(upload, UploadFile):
            raise refusal(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "stt_invalid_audio", "No recording sent."
            )
        audio = await upload.read()
        content_type = upload.content_type or "audio/webm"
    with business_errors():
        text = await run_in_threadpool(
            speech_to_text.transcribe,
            settings,
            audio,
            content_type=content_type,
            transport=getattr(request.app.state, "stt_transport", None),
        )
    return TranscriptOut(text=text)
