"""Prospect notes: what `test_prospect_notes_api.py` leaves out — the CSRF protection of the writes
and how the audit events of a note read in the prospect's history."""

import uuid

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.services import history
from tests.builders import add_company, add_prospect

PROSPECTS = "/api/prospects"
FACT = "A liké notre post LinkedIn sur notre nouvelle IA : IGuard"


def notes_url(prospect_id: uuid.UUID | str) -> str:
    return f"{PROSPECTS}/{prospect_id}/notes"


def test_writes_need_the_csrf_token(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    note = client.post(notes_url(prospect.id), json={"fact_text": FACT}).json()
    del client.headers[CSRF_HEADER]

    assert client.post(notes_url(prospect.id), json={"fact_text": FACT}).status_code == 403
    assert client.delete(f"{notes_url(prospect.id)}/{note['id']}").status_code == 403
    assert client.get(notes_url(prospect.id)).status_code == 200


def test_a_note_is_read_in_the_prospects_history(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    note = client.post(notes_url(prospect.id), json={"fact_text": FACT}).json()
    client.delete(f"{notes_url(prospect.id)}/{note['id']}")

    db_session.expire_all()
    page = history.history_page(db_session, "prospect", prospect.id, limit=10, before=None)

    assert FACT in repr(page)
