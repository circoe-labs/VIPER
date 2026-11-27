"""Dispatch explicitly scheduled warehouse mails, without retrying an uncertain send."""

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext, ActorType
from app.core.config import allowlist_permits
from app.db.session import unit_of_work
from app.models import WarehouseDraft
from app.services import audit
from app.services.contact_dispatch import (
    MISSING_RECIPIENTS,
    OVERDUE,
    RECIPIENT_NOT_ALLOWED,
    DispatchConfig,
)
from app.services.errors import ToolboxError
from app.services.toolbox.mcp_client import DraftInput, MailToolbox

ACTOR = ActorContext(type=ActorType.SYSTEM, display="VIPER")
logger = logging.getLogger(__name__)


def dispatch_warehouses(
    factory: sessionmaker[Session], config: DispatchConfig, toolbox: MailToolbox
) -> None:
    now = datetime.now(UTC)
    with factory() as session:
        ids = list(
            session.scalars(
                select(WarehouseDraft.id)
                .where(WarehouseDraft.send_state == "scheduled", WarehouseDraft.scheduled_at <= now)
                .order_by(WarehouseDraft.scheduled_at)
                .limit(config.batch_size)
            )
        )
    for draft_id in ids:
        with unit_of_work(factory) as session:
            draft = session.scalar(
                select(WarehouseDraft)
                .where(WarehouseDraft.id == draft_id)
                .with_for_update(skip_locked=True)
            )
            if (
                draft is None
                or draft.send_state != "scheduled"
                or draft.scheduled_at is None
                or draft.scheduled_at > now
            ):
                continue
            refusal = None
            if now - draft.scheduled_at > config.max_lateness:
                refusal = OVERDUE
            elif draft.validated_at is None or not draft.human_validated:
                refusal = "not_validated"
            elif not draft.recipient:
                refusal = MISSING_RECIPIENTS
            elif not allowlist_permits(config.allowlist, [draft.recipient]):
                refusal = RECIPIENT_NOT_ALLOWED
            if refusal is not None:
                draft.send_state = "failed"
                draft.failure_code = refusal
                draft.failed_at = now
                draft.revision += 1
                audit.record_event(
                    session,
                    ACTOR,
                    "warehouse_draft.failed",
                    entity_type="warehouse_draft",
                    entity_id=draft.id,
                    reason=refusal,
                )
                logger.warning("warehouse_dispatch.refused draft_id=%s code=%s", draft.id, refusal)
                continue
            draft.send_state = "sending"
            draft.revision += 1
            content = DraftInput(to=[draft.recipient], subject=draft.subject, text=draft.body)
        # The committed sending state is a durable claim; unknown outcomes are never retried.
        stage = "create_draft"
        try:
            remote_id = toolbox.create_draft(content)
            with unit_of_work(factory) as session:
                claimed = session.get(WarehouseDraft, draft_id, with_for_update=True)
                if claimed is None or claimed.send_state != "sending":
                    continue
                claimed.remote_draft_id = remote_id
            stage = "send_draft"
            toolbox.send_draft(remote_id)
        except Exception as error:
            error_code = error.code if isinstance(error, ToolboxError) else type(error).__name__
            upstream_status = error.upstream_status if isinstance(error, ToolboxError) else None
            logger.error(
                "warehouse_dispatch.failed draft_id=%s stage=%s error_code=%s upstream_status=%s",
                draft_id,
                stage,
                error_code,
                upstream_status,
            )
            with unit_of_work(factory) as session:
                claimed = session.get(WarehouseDraft, draft_id, with_for_update=True)
                if claimed is not None and claimed.send_state == "sending":
                    code = f"{stage}:{error_code}" + (
                        f":http_{upstream_status}" if upstream_status is not None else ""
                    )
                    claimed.send_state = "uncertain"
                    claimed.failure_code = code[:255]
                    claimed.failed_at = datetime.now(UTC)
                    claimed.revision += 1
                    audit.record_event(
                        session,
                        ACTOR,
                        "warehouse_draft.failed",
                        entity_type="warehouse_draft",
                        entity_id=claimed.id,
                        reason=code,
                    )
            continue
        with unit_of_work(factory) as session:
            claimed = session.get(WarehouseDraft, draft_id, with_for_update=True)
            if claimed is not None and claimed.send_state == "sending":
                claimed.send_state = "sent"
                claimed.revision += 1
                logger.info("warehouse_dispatch.sent draft_id=%s", claimed.id)
                audit.record_event(
                    session,
                    ACTOR,
                    "warehouse_draft.sent",
                    entity_type="warehouse_draft",
                    entity_id=claimed.id,
                )
