"""Will a scheduled message really leave? (Contact port S9, Human report of 2026-10-02).

A message was scheduled while the dispatcher was off (the S8 default) and never left: nothing on the
page said so. This is the one answer every screen reads — the Contact banner
(`GET /api/contact/dashboard`), the editor (`GET /api/prospects/{id}/messages`) and the
« Envoi programmé » card (`GET /api/settings/integrations`):

- `active`           the dispatcher worker runs and the Toolbox is connected;
- `reason`           why not, first the person's own choice then the Toolbox:
                     `disabled` (« Envoi automatique des mails programmés » off),
                     `toolbox_disabled`, `toolbox_not_configured`, `toolbox_disconnected`,
                     `toolbox_expired`, `not_running` (connected and switched on but no worker:
                     should not happen, see the server log);
- `scheduled_count`  messages in Programmé;
- `overdue_count`    of those, not claimed and whose time has passed (waiting for a pass).
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.services.contact_dispatch import dispatch_counts
from app.services.contact_dispatch_worker import ContactDispatcher
from app.services.toolbox.integration import ToolboxIntegration

DispatchReason = Literal[
    "disabled",
    "toolbox_disabled",
    "toolbox_not_configured",
    "toolbox_disconnected",
    "toolbox_expired",
    "not_running",
]

_TOOLBOX_REASONS: dict[str, DispatchReason] = {
    "disabled": "toolbox_disabled",
    "not_configured": "toolbox_not_configured",
    "disconnected": "toolbox_disconnected",
    "expired": "toolbox_expired",
}


@dataclass(frozen=True, slots=True)
class DispatchState:
    active: bool
    reason: DispatchReason | None
    scheduled_count: int
    overdue_count: int


def sending_reason(state: Any) -> DispatchReason | None:
    """None when a scheduled message will leave; else why not (no database read)."""
    settings: Settings = state.settings
    dispatcher: ContactDispatcher | None = state.contact_dispatcher
    if dispatcher is not None and dispatcher.status().active:
        return None
    if not settings.contact_dispatch_on:
        return "disabled"
    integration: ToolboxIntegration = state.toolbox
    return _TOOLBOX_REASONS.get(integration.status().state, "not_running")


def dispatch_state(state: Any, session: Session, now: datetime | None = None) -> DispatchState:
    """`state` is the app's `State` (`settings`, `toolbox`, `contact_dispatcher`)."""
    settings: Settings = state.settings
    reason = sending_reason(state)
    counts = dispatch_counts(session, claim_ttl=settings.contact_dispatch_claim_ttl, now=now)
    return DispatchState(
        active=reason is None,
        reason=reason,
        scheduled_count=counts.scheduled,
        overdue_count=counts.overdue,
    )
