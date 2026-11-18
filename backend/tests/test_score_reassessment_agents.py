"""« Réévaluer le score »: who can pick the task up (root cause of the « searched for 15 minutes »
production report).

VIPER launches no agent: external MCP clients poll the queue. A token whose explicit scope list
predates `reassess_score` was never offered the task, which stayed `pending` forever; the card now
also learns whether any live agent could take it (`agents_available`)."""

import importlib.util
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models.mcp import McpToken
from app.services import mcp_tokens
from tests.builders import add_company, add_prospect
from tests.test_mcp_tools import body, call
from tests.test_missions import mint

OLDER_TYPES = ["update_company", "update_employee", "find_employees", "surveil_signals"]
MIGRATION = Path(__file__).parent.parent / "migrations/versions/0057_reassess_score_scope_backfill.py"


def url(prospect_id: Any) -> str:
    return f"/api/prospects/{prospect_id}/score/reassessment"


def test_a_token_scoped_without_reassess_score_never_sees_the_task_but_a_scoped_one_does(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    client.post(url(prospect.id), json={})
    old = mint(db_session, label="Agent vieux", scopes=OLDER_TYPES)

    assert "reassess_score" not in body(call(client, old, "viper_task_queue", {}))["tasks"]
    assert body(call(client, old, "viper_claim_task", {}))["task"] is None
    state = client.get(url(prospect.id)).json()
    assert state["status"] == "queued"
    assert state["agents_available"] == 0

    new = mint(db_session, label="Agent neuf", scopes=["reassess_score"])
    assert body(call(client, new, "viper_task_queue", {}))["tasks"] == {"reassess_score": 1}
    assert client.get(url(prospect.id)).json()["agents_available"] == 1
    claimed = body(call(client, new, "viper_claim_task", {}))
    assert claimed["task"] == "reassess_score"
    running = client.get(url(prospect.id)).json()
    assert (running["status"], running["agents_available"]) == ("running", 1)


def test_the_scope_backfill_completes_only_tokens_that_listed_every_older_type(
    db_session: Session,
) -> None:
    spec = importlib.util.spec_from_file_location("migration_0057", MIGRATION)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    mcp_tokens.mint(db_session, label="full", scopes=[*OLDER_TYPES, "find_prospects"])
    mcp_tokens.mint(db_session, label="narrow", scopes=["find_prospects"])
    mcp_tokens.mint(db_session, label="wild", scopes=["*"])
    db_session.flush()

    db_session.execute(text(migration.BACKFILL_SQL))
    db_session.expire_all()

    scopes = {t.label: t.scopes for t in db_session.scalars(select(McpToken)).all()}
    assert "reassess_score" in scopes["full"]
    assert scopes["narrow"] == ["find_prospects"]
    assert scopes["wild"] == ["*"]
