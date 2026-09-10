"""The read-only loader builds the engine's reference snapshot from the database."""

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models import InternalReferent
from app.models.enums import ContactabilityStatus
from app.seed import seed_taxonomies
from app.services.imports.preview import ImportFile, build_preview
from app.services.imports.reference_loader import load_reference_data
from app.services.prospects import mark_do_not_contact
from tests.builders import OPERATOR, add_company, add_email, add_prospect
from tests.fixtures.synthetic.legacy_workbook import legacy_xlsx


def test_snapshot_holds_taxonomies_referents_companies_and_prospects(db_session: Session) -> None:
    seed_taxonomies(db_session)
    referent = InternalReferent(first_name="Claire", last_name="Référente", active=False)
    db_session.add(referent)
    company = add_company(db_session, "Logistique Démo SAS", email_domain="logistique-demo.example")
    prospect = add_prospect(db_session, company, first_name="Bruno", last_name="Bloqué")
    add_email(db_session, prospect, "bruno.bloque@logistique-demo.example")
    mark_do_not_contact(db_session, OPERATOR, prospect.id, reason="Opposition fictive")
    db_session.flush()

    reference = load_reference_data(db_session)

    assert "Responsable transport" in {role.label for role in reference.roles}
    assert "Transporteur" in {segment.label for segment in reference.commercial_segments}
    assert len(reference.activity_categories) >= 4
    (loaded_referent,) = [r for r in reference.referents if r.id == referent.id]
    assert (loaded_referent.display, loaded_referent.active) == ("Claire Référente", False)
    (loaded_company,) = [c for c in reference.companies if c.id == company.id]
    assert loaded_company.email_domain == "logistique-demo.example"
    (loaded,) = [p for p in reference.prospects if p.id == prospect.id]
    assert loaded.company_id == company.id
    assert loaded.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert loaded.emails == ("bruno.bloque@logistique-demo.example",)


def test_loader_only_reads(db_session: Session) -> None:
    add_company(db_session, "Transports Exemple SARL")
    db_session.flush()
    statements: list[str] = []
    connection = db_session.connection()

    def record(*args: object) -> None:
        statements.append(str(args[2]).lstrip().upper())

    event.listen(connection, "before_cursor_execute", record)
    try:
        load_reference_data(db_session)
    finally:
        event.remove(connection, "before_cursor_execute", record)

    assert statements and all(statement.startswith("SELECT") for statement in statements)
    assert not db_session.new and not db_session.dirty


def test_database_snapshot_feeds_the_blocking_rule(db_session: Session) -> None:
    company = add_company(db_session, "Logistique Démo SAS")
    prospect = add_prospect(db_session, company, first_name="Bruno", last_name="Bloqué")
    mark_do_not_contact(db_session, OPERATOR, prospect.id, reason="Opposition fictive")
    db_session.flush()
    content = legacy_xlsx(
        [{"first_name": "Bruno", "last_name": "BLOQUE", "company": "Logistique Démo"}]
    )

    preview = build_preview(ImportFile("base.xlsx", content), load_reference_data(db_session))

    (row,) = preview.rows
    assert row.blocked_by_do_not_contact
    assert [d.prospect_id for d in row.duplicates] == [prospect.id]
