"""Warehouse drafts: one subject per contact, short job title, no company picked from several, and
the repair command for existing drafts (user feedback 2026-11-27, item 1). Synthetic data."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app import cli
from app.models import AuditLogEntry, Warehouse, WarehouseDraft
from app.services.warehouse_draft_text import (
    LEGACY_SUBJECTS,
    draft_subject,
    draft_text,
    rewrite_body,
)

LONG = "Responsable des opérations logistiques internationales"
LEGACY = "Échangeons sur vos priorités logistiques et le numérique"


def test_two_colleagues_never_share_a_subject() -> None:
    taken: set[str] = set()
    for number in range(15):
        subject = draft_subject("Responsable logistique", "Alpha - Quai", f"Test {number}", taken)
        assert subject not in taken and subject not in LEGACY_SUBJECTS
        assert "Alpha" in subject
        taken.add(subject)


def test_a_label_with_several_companies_is_never_attributed() -> None:
    subject = draft_subject(LONG, "Alpha / Beta", "Anne Test", city="Ville Test")
    assert "Alpha" not in subject and "Beta" not in subject and "Ville Test" in subject
    for category in ("sme", "other"):
        body = draft_text("Anne Test", "Alpha / Beta", LONG, category)
        assert "Alpha" not in body and "Beta" not in body
        assert "au sujet de votre activité." in body
        assert "opérations logistiques internationales" not in body


def test_the_company_is_named_once_and_the_title_is_short() -> None:
    body = draft_text("Anne Test", "Alpha SAS", "Directeur logistique Alpha", "other")
    assert body.count("Alpha") == 1
    assert "En tant que Directeur logistique, " in body
    untitled = draft_text("Anne Test", "Alpha", "En charge de toute la partie entrepôt", "other")
    assert "En tant que" not in untitled and "Vous pilotez au quotidien" in untitled


@pytest.mark.parametrize("category", ["sme", "other"])
def test_a_former_body_is_brought_to_the_current_wording(category: str) -> None:
    role = LONG
    start = "Je vous contacte" if category == "sme" else "Je me permets de vous écrire"
    context = (
        f"Je souhaiterais mieux comprendre votre quotidien dans vos fonctions de {role} et vos "
        "priorités."
        if category == "sme"
        else f"En tant que {role}, vous pilotez au quotidien l’organisation logistique et le "
        "travail des équipes."
    )
    former = f"{start} au sujet de votre activité chez Alpha / Beta.\n\n{context}\n\nFin ajoutée."

    body = rewrite_body(former, "Alpha / Beta", role)

    assert "Alpha" not in body and role not in body
    assert "Responsable" in body and body.endswith("Fin ajoutée.")
    assert rewrite_body(body, "Alpha / Beta", role) == body


def legacy_draft(site: Warehouse, name: str, **over: object) -> WarehouseDraft:
    values: dict[str, object] = {
        "warehouse_id": site.id,
        "warehouse_name": site.name,
        "contact_name": name,
        "contact_role": LONG,
        "recipient": "a@example.test",
        "subject": LEGACY,
        "body": f"Je vous contacte au sujet de votre activité chez {site.name}.",
        "review_note": "À vérifier",
    }
    return WarehouseDraft(**{**values, **over})


def test_the_rewrite_command_is_a_dry_run_then_applies_once(
    client: TestClient, db_session: Session, capsys: pytest.CaptureFixture[str]
) -> None:
    site = Warehouse(name="Alpha / Beta", contacts=[])
    db_session.add(site)
    db_session.flush()
    when = datetime.now(UTC) + timedelta(days=2)
    scheduled = legacy_draft(
        site,
        "Anne Test",
        send_state="scheduled",
        scheduled_at=when,
        validated_at=datetime.now(UTC),
        validated_by="Test",
        human_validated=True,
    )
    other = legacy_draft(site, "Jean Test")
    sent = legacy_draft(site, "Sent Test", send_state="sent")
    edited = legacy_draft(site, "Edited Test")
    db_session.add_all([scheduled, other, sent, edited])
    db_session.flush()
    # A person saves one draft from the editor: it is theirs from then on.
    saved = client.put(
        f"/api/warehouses/drafts/{edited.id}",
        json={"revision": 1, "recipient": "a@example.test", "subject": LEGACY, "body": "Mon texte"},
    )
    assert saved.status_code == 200, saved.text
    factory = sessionmaker(bind=db_session.connection(), join_transaction_mode="create_savepoint")

    def subjects() -> dict[str, str]:
        db_session.expire_all()
        return {d.contact_name: d.subject for d in db_session.scalars(select(WarehouseDraft))}

    assert cli.main(["warehouse-drafts-rewrite"], factory) == 0
    output = capsys.readouterr().out
    assert "dry run" in output and "2 warehouse draft(s), of which 1 lose" in output
    assert "1 edited by hand" in output
    assert set(subjects().values()) == {LEGACY}

    assert cli.main(["warehouse-drafts-rewrite", "--apply"], factory) == 0
    after = subjects()
    assert after["Sent Test"] == after["Edited Test"] == LEGACY
    assert LEGACY not in (after["Anne Test"], after["Jean Test"])
    assert after["Anne Test"] != after["Jean Test"]
    row = db_session.get(WarehouseDraft, scheduled.id)
    assert row is not None
    assert (row.send_state, row.human_validated, row.validated_at, row.validated_by) == (
        "planned",
        False,
        None,
        None,
    )
    assert (row.scheduled_at, row.revision) == (when, 2)
    assert "Alpha" not in row.body
    events = db_session.scalars(
        select(AuditLogEntry.entity_id).where(AuditLogEntry.action == "warehouse_draft.rewritten")
    ).all()
    assert set(events) == {scheduled.id, other.id}

    capsys.readouterr()
    assert cli.main(["warehouse-drafts-rewrite", "--apply"], factory) == 0
    assert "Rewritten: 0 warehouse draft(s)" in capsys.readouterr().out
    assert subjects() == after
