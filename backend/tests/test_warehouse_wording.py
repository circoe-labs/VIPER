"""Warehouse drafts: one subject per contact, short job title, no company picked from several, and
the repair command for existing drafts (user feedback 2026-11-27, item 1). Synthetic data."""

import pytest

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
