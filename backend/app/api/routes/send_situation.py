"""The API shape of `contact_send_state.SendSituation`, shared by every payload naming a
prospect's send (planning lists, Prospection list, prospect editor, unsent sends)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class SendSituationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    state: Literal["unconfirmed", "missed", "scheduled", "unscheduled"]
    rank: int
    step: str
    step_label: str
    # The effective send moment, or the one that was missed.
    scheduled_at: datetime | None
    reason: str | None
    at: datetime | None
    draft_missing: bool
    needs_sent_check: bool
