"""Import HTTP API (`/api/imports`, Task 09): protection, upload bounds, review, commit, history.
Synthetic workbooks only."""

import json
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.core.actor import ActorType
from app.core.config import Settings
from app.main import create_app
from app.models import ImportBatch, Prospect, User
from app.services import provenance
from tests.builders import audit_events
from tests.fixtures.synthetic.legacy_workbook import SAMPLE_ROWS, legacy_xlsx
from tests.import_support import FILENAME, LEGAL_BASIS, seed

IMPORTS = "/api/imports"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
CONTENT = legacy_xlsx(SAMPLE_ROWS)


@pytest.fixture
def ids(db_session: Session) -> dict[str, uuid.UUID]:
    return seed(db_session)


def files(content: bytes = CONTENT, name: str = FILENAME) -> dict[str, tuple[str, bytes, str]]:
    return {"file": (name, content, XLSX)}


def preview(client: TestClient, options: dict[str, Any] | None = None) -> dict[str, Any]:
    data = {"options": json.dumps(options)} if options else None
    response = client.post(f"{IMPORTS}/preview", files=files(), data=data)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def decisions(review: dict[str, Any], **fields: Any) -> dict[str, str]:
    body = {
        "file_fingerprint": review["preview"]["summary"]["file_fingerprint"],
        "preview_digest": review["digest"],
        "legal_basis_or_collection_context": LEGAL_BASIS,
        "rows": {"10": {"resolution": {"action": "exclude"}}},
        **fields,
    }
    return {"decisions": json.dumps(body)}


def commit(client: TestClient, review: dict[str, Any], **fields: Any) -> Any:
    return client.post(f"{IMPORTS}/commit", files=files(), data=decisions(review, **fields))


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", IMPORTS),
        ("GET", f"{IMPORTS}/{uuid.uuid4()}"),
        ("POST", f"{IMPORTS}/preview"),
        ("POST", f"{IMPORTS}/commit"),
    ],
)
def test_imports_need_a_session(anonymous_client: TestClient, method: str, path: str) -> None:
    upload = files() if method == "POST" else None
    assert anonymous_client.request(method, path, files=upload).status_code == 401


def test_uploads_need_the_csrf_token(client: TestClient) -> None:
    del client.headers[CSRF_HEADER]

    assert client.post(f"{IMPORTS}/preview", files=files()).status_code == 403
    assert client.get(IMPORTS).status_code == 200


def test_preview_returns_the_review_and_writes_nothing(
    client: TestClient, db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    body = preview(client)

    review = body["review"]
    assert body["previous_imports"] == []
    assert review["preview"]["summary"]["rows_total"] == len(SAMPLE_ROWS)
    assert len(review["digest"]) == 64 and len(review["rows"]) == len(SAMPLE_ROWS)
    assert {group["text"] for group in review["referents"]} >= {"xxx", "Paul"}
    blocked = next(row for row in review["rows"] if row["row_number"] == 9)
    assert blocked["default_resolution"] == {"action": "exclude"}
    assert db_session.scalars(select(ImportBatch)).all() == []


def test_preview_options_carry_corrections(client: TestClient, ids: dict[str, uuid.UUID]) -> None:
    body = preview(client, {"corrections": {"10": {"first_name": "Zoé"}}})

    row = next(r for r in body["review"]["preview"]["rows"] if r["row_number"] == 10)
    assert row["prospect"]["first_name"] == "Zoé" and row["status"] != "error"


@pytest.mark.parametrize(
    ("name", "content", "code"),
    [
        ("vide.xlsx", b"", "file.empty"),
        ("ancien.xls", bytes.fromhex("D0CF11E0A1B11AE1") + b"\0" * 64, "file.legacy_xls"),
        ("image.png", b"\x89PNG....", "file.unsupported_format"),
    ],
)
def test_unreadable_files_are_refused_with_the_engine_message(
    client: TestClient, name: str, content: bytes, code: str
) -> None:
    response = client.post(f"{IMPORTS}/preview", files=files(content, name))

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert (detail["code"], detail["diagnostic"]["code"]) == ("file_rejected", code)
    assert detail["message"] == detail["diagnostic"]["message"]


def test_a_missing_file_is_refused(client: TestClient) -> None:
    response = client.post(f"{IMPORTS}/preview", data={"options": "{}"})

    assert response.status_code == 422
    assert response.json()["detail"]["diagnostic"]["code"] == "file.empty"


@pytest.fixture
def small_limit_client(
    test_database_url: str, app: FastAPI, client: TestClient
) -> Iterator[TestClient]:
    """The signed-in client against an app whose import limit is 1 MiB."""
    limited = create_app(Settings(database_url=test_database_url, import_max_file_mb=1))
    limited.state.session_factory = app.state.session_factory
    with TestClient(
        limited,
        base_url=str(client.base_url),
        cookies=client.cookies,
        headers=dict(client.headers),
    ) as limited_client:
        yield limited_client


def test_uploads_are_bounded_before_and_after_parsing(small_limit_client: TestClient) -> None:
    huge = small_limit_client.post(
        f"{IMPORTS}/preview", files=files(b"x" * (3 * 1024 * 1024 + 1), "gros.csv")
    )
    over = small_limit_client.post(
        f"{IMPORTS}/preview", files=files(b"x" * (1024 * 1024 + 1), "gros.csv")
    )

    assert huge.status_code == 413
    assert huge.json()["detail"]["diagnostic"]["code"] == "file.too_large"
    assert over.status_code == 422
    assert over.json()["detail"]["diagnostic"]["code"] == "file.too_large"


def test_malformed_options_are_refused_without_echoing_values(client: TestClient) -> None:
    response = client.post(
        f"{IMPORTS}/preview",
        files=files(),
        data={"options": json.dumps({"corrections": {"2": {"email": 7}}, "secret": "valeur"})},
    )

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "invalid_request"
    assert "valeur" not in response.text and all("input" not in e for e in detail["errors"])


def test_commit_imports_and_lists_the_batch_in_the_history(
    client: TestClient, db_session: Session, pilot_user: User, ids: dict[str, uuid.UUID]
) -> None:
    review = preview(client)["review"]

    response = commit(client, review, source_reference="Export fictif 2026")

    assert response.status_code == 200, response.text
    body = response.json()
    batch = body["batch"]
    assert (batch["status"], batch["rows_imported"], batch["rows_skipped"]) == ("committed", 8, 2)
    assert (batch["actor_type"], batch["actor_display"]) == ("human", "Pilote Test")
    assert batch["source_reference"] == "Export fictif 2026"
    assert body["counts"]["prospects_created"] == 8
    history = client.get(IMPORTS).json()
    assert [item["id"] for item in history] == [batch["id"]]
    detail = client.get(f"{IMPORTS}/{batch['id']}").json()
    assert (detail["rows_traced"], detail["prospect_count"], detail["company_count"]) == (8, 8, 5)
    assert "legacy_metadata" not in json.dumps(history) + json.dumps(detail)
    events = audit_events(db_session, action="import_batch.committed")
    assert [(e.actor_type, e.actor_id) for e in events] == [(ActorType.HUMAN, str(pilot_user.id))]
    imported = audit_events(db_session, action="prospect.created")
    assert {e.context["on_behalf_of"]["id"] for e in imported} == {str(pilot_user.id)}


def test_commit_refusals(
    client: TestClient, db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    review = preview(client)["review"]

    invalid = commit(client, review, rows={})
    stale = client.post(
        f"{IMPORTS}/commit",
        files=files(legacy_xlsx(SAMPLE_ROWS[:3])),
        data=decisions(review),
    )
    missing = client.post(f"{IMPORTS}/commit", files=files())

    assert invalid.status_code == 422
    assert invalid.json()["detail"]["code"] == "invalid_decisions"
    assert invalid.json()["detail"]["errors"] == [
        {"code": "missing_name", "row": 10, "group": None, "key": None}
    ]
    assert (stale.status_code, stale.json()["detail"]["code"]) == (409, "file_changed")
    assert (missing.status_code, missing.json()["detail"]["code"]) == (422, "invalid_request")


def test_a_reimport_needs_an_acknowledgement(client: TestClient, ids: dict[str, uuid.UUID]) -> None:
    first = commit(client, preview(client)["review"]).json()["batch"]
    again = preview(client)
    assert [batch["id"] for batch in again["previous_imports"]] == [first["id"]]

    refused = commit(client, again["review"])
    accepted = commit(client, again["review"], acknowledge_reimport=True)

    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "reimport_not_acknowledged"
    assert [b["id"] for b in refused.json()["detail"]["previous"]] == [first["id"]]
    assert accepted.status_code == 200


def test_a_failed_commit_keeps_only_the_failed_batch_record(
    client: TestClient,
    db_session: Session,
    ids: dict[str, uuid.UUID],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("panne simulée")

    monkeypatch.setattr(provenance, "add_import_source", broken)
    review = preview(client)["review"]

    response = commit(client, review)

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert (detail["code"], detail["row"], detail["reason"]) == ("commit_failed", 2, "unexpected")
    history = client.get(IMPORTS).json()
    assert [(b["id"], b["status"]) for b in history] == [(detail["batch_id"], "failed")]
    imported = db_session.scalars(select(Prospect).where(Prospect.last_name == "Test")).all()
    assert [p.first_name for p in imported] == []
    assert db_session.get(ImportBatch, uuid.UUID(detail["batch_id"])) is not None
    assert "panne" not in response.text


def test_an_unknown_batch_is_not_found(client: TestClient) -> None:
    response = client.get(f"{IMPORTS}/{uuid.uuid4()}")

    assert (response.status_code, response.json()["detail"]["code"]) == (404, "not_found")
