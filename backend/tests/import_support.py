"""Shared setup of the import review/commit tests (Task 09). Every value is invented."""

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.models import ActivityCategory, CommercialSegment, InternalReferent, Role
from app.models.enums import VerificationStatus
from app.services import prospects
from tests.builders import OPERATOR, add_company, add_email, add_phone, add_prospect

FILENAME = "base_synthetique.xlsx"
SHEET = "Base client "
LEGAL_BASIS = "Fichier historique Circoe — prospection B2B"


def seed(session: Session) -> dict[str, uuid.UUID]:
    """Settings values and existing records the synthetic rows refer to (all invented)."""
    rows: dict[str, Any] = {
        "dirigeant": Role(label="Dirigeant", slug="dirigeant"),
        "transport": Role(label="Responsable transport", slug="responsable-transport"),
        "quai": Role(label="Chef de quai", slug="chef-de-quai", active=False),
        "road": ActivityCategory(
            label="Transport routier de marchandises", slug="transport-routier-marchandises"
        ),
        "storage": ActivityCategory(label="Entreposage et stockage", slug="entreposage-stockage"),
        "carrier": CommercialSegment(label="Transporteur", slug="transporteur"),
        "claire": InternalReferent(first_name="Claire", last_name="Référente"),
        "paul": InternalReferent(first_name="Paul", last_name="Démo"),
    }
    session.add_all(rows.values())
    session.flush()
    demo = add_company(session, "Logistique Démo SAS")
    blocked = add_prospect(session, demo, first_name="Bruno", last_name="Bloqué")
    add_email(session, blocked, "bruno.bloque@logistique-demo.example")
    luc = add_prospect(session, demo, first_name="Luc", last_name="Exemple")
    add_email(
        session,
        luc,
        "luc.exemple@example.com",
        is_primary=True,
        verification_status=VerificationStatus.VERIFIED,
    )
    add_phone(session, luc, "+33100000009", is_primary=True)
    homonym = add_prospect(session, None, first_name="Nina", last_name="Homonyme")
    prospects.mark_do_not_contact(session, OPERATOR, blocked.id, reason="Opposition fictive")
    prospects.mark_do_not_contact(session, OPERATOR, homonym.id, reason="Opposition fictive")
    ids = {name: row.id for name, row in rows.items()}
    return ids | {"demo": demo.id, "blocked": blocked.id, "luc": luc.id, "homonym": homonym.id}
