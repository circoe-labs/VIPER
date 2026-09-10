"""Database-enforced invariants: uniqueness, partial indexes, CHECKs, deletion rules, triggers."""

from datetime import UTC, datetime

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.orm import Session

from app.models import (
    ActivityCategory,
    AuditLogEntry,
    Company,
    ContactTracking,
    ContactTrackingStatusHistory,
    Email,
    Establishment,
    ImportBatch,
    ImportRowMetadata,
    InternalReferent,
    Phone,
    Prospect,
    ProspectSource,
    Role,
)
from app.models.enums import (
    ContactabilityStatus,
    ContactTrackingStatus,
    ImportBatchStatus,
    ProspectSourceType,
)
from tests.builders import (
    OPERATOR,
    add_company,
    add_email,
    add_phone,
    add_prospect,
    add_role,
    rejected,
)


def count(session: Session, model: type[object]) -> int:
    return session.execute(select(func.count()).select_from(model)).scalar_one()


# --- companies & establishments ---------------------------------------------------------------


def test_siren_is_unique_when_present_and_null_repeats_are_allowed(db_session: Session) -> None:
    add_company(db_session, "Transports Exemple SARL", siren="123456789")
    add_company(db_session, "Logistique Fictive SAS")
    add_company(db_session, "Entrepôts Imaginaires")

    with rejected(db_session, "uq_companies_siren"):
        add_company(db_session, "Doublon Exemple", siren="123456789")


def test_siren_and_siret_must_be_digits_only(db_session: Session) -> None:
    with rejected(db_session, "ck_companies_siren_format"):
        add_company(db_session, siren="12345678A")

    company = add_company(db_session)
    with rejected(db_session, "ck_establishments_siret_format"):
        db_session.add(Establishment(company_id=company.id, siret="1234567890123X"))


def test_siret_is_unique_when_present(db_session: Session) -> None:
    company = add_company(db_session)
    db_session.add_all(
        [
            Establishment(company_id=company.id, siret="12345678900011"),
            Establishment(company_id=company.id),
            Establishment(company_id=company.id),
        ]
    )
    db_session.flush()

    with rejected(db_session, "uq_establishments_siret"):
        db_session.add(Establishment(company_id=company.id, siret="12345678900011"))


def test_one_primary_establishment_per_company(db_session: Session) -> None:
    company, other = add_company(db_session), add_company(db_session, "Autre Exemple SA")
    db_session.add_all(
        [
            Establishment(company_id=company.id, kind="siège", is_primary=True),
            Establishment(company_id=company.id, kind="agence"),
            Establishment(company_id=other.id, is_primary=True),
        ]
    )
    db_session.flush()

    with rejected(db_session, "uq_establishments_company_id_primary"):
        db_session.add(Establishment(company_id=company.id, kind="entrepôt", is_primary=True))


def test_email_domain_is_stored_normalized(db_session: Session) -> None:
    add_company(db_session, email_domain="exemple-transports.test")

    with rejected(db_session, "ck_companies_email_domain_format"):
        add_company(db_session, "Majuscules SARL", email_domain="Exemple.TEST")


def test_company_has_many_activity_categories_and_categories_are_shared(
    db_session: Session,
) -> None:
    categories = [
        ActivityCategory(slug=f"categorie-{index}", label=f"Catégorie {index}")
        for index in range(3)
    ]
    company = add_company(db_session)
    other = add_company(db_session, "Autre Exemple SA")
    company.activity_categories = categories
    other.activity_categories = [categories[0]]
    db_session.flush()
    db_session.expire_all()

    assert {category.slug for category in company.activity_categories} == {
        "categorie-0",
        "categorie-1",
        "categorie-2",
    }
    assert [category.slug for category in other.activity_categories] == ["categorie-0"]


def test_company_deletion_removes_its_establishments_and_category_links(
    db_session: Session,
) -> None:
    category = ActivityCategory(slug="categorie-test", label="Catégorie test")
    company = add_company(db_session, activity_categories=[category])
    db_session.add(Establishment(company_id=company.id))
    db_session.flush()

    db_session.execute(delete(Company).where(Company.id == company.id))

    assert count(db_session, Establishment) == 0
    assert count(db_session, ActivityCategory) == 1


def test_company_with_prospects_cannot_be_deleted(db_session: Session) -> None:
    company = add_company(db_session)
    add_prospect(db_session, company)

    with rejected(db_session, "fk_prospects_company_id_companies"):
        db_session.execute(delete(Company).where(Company.id == company.id))


# --- taxonomies & referents -------------------------------------------------------------------


def test_taxonomy_slug_and_folded_label_are_unique(db_session: Session) -> None:
    add_role(db_session, "dirigeant", "Dirigeant")
    add_role(db_session, "securite", "Responsable sécurité")

    with rejected(db_session, "uq_roles_slug"):
        add_role(db_session, "dirigeant", "Autre libellé")
    with rejected(db_session, "uq_roles_label_key"):
        add_role(db_session, "dirigeant-bis", "DIRIGEANT")
    with rejected(db_session, "uq_roles_label_key"):
        add_role(db_session, "securite-bis", " responsable   SECURITE")
    with rejected(db_session, "ck_roles_slug_format"):
        add_role(db_session, "Dirigeant Bis", "Dirigeant bis")


def test_referent_full_names_and_emails_are_unique(db_session: Session) -> None:
    db_session.add(InternalReferent(first_name="Hélène", last_name="Démo", email="h@example.com"))
    db_session.flush()

    with rejected(db_session, "uq_internal_referents_name_key"):
        db_session.add(InternalReferent(first_name="helene", last_name="DEMO"))
    with rejected(db_session, "uq_internal_referents_email"):
        db_session.add(
            InternalReferent(first_name="Autre", last_name="Personne", email="h@example.com")
        )
    db_session.add_all(
        [
            InternalReferent(first_name="Hélène", last_name="Autre"),
            InternalReferent(first_name="Sans", last_name="Adresse"),
        ]
    )
    db_session.flush()


def test_referenced_taxonomy_rows_cannot_be_deleted_but_can_be_deactivated(
    db_session: Session,
) -> None:
    role = add_role(db_session)
    category = ActivityCategory(slug="categorie-test", label="Catégorie test")
    add_company(db_session, activity_categories=[category])
    prospect = add_prospect(db_session, role_id=role.id)

    with rejected(db_session, "fk_prospects_role_id_roles"):
        db_session.execute(delete(Role).where(Role.id == role.id))
    with rejected(db_session, "fk_company_activity_categories_activity_category_id"):
        db_session.execute(delete(ActivityCategory).where(ActivityCategory.id == category.id))

    role.active = False
    db_session.flush()
    db_session.expire_all()
    assert prospect.role_id == role.id


def test_referent_in_use_cannot_be_deleted(db_session: Session) -> None:
    referent = InternalReferent(first_name="Claire", last_name="Référente")
    prospect = add_prospect(db_session)
    db_session.add(referent)
    db_session.flush()
    db_session.add(ContactTracking(prospect_id=prospect.id, referent_id=referent.id))
    db_session.flush()

    with rejected(db_session, "fk_contact_tracking_referent_id_internal_referents"):
        db_session.execute(delete(InternalReferent).where(InternalReferent.id == referent.id))


# --- prospects & contact channels -------------------------------------------------------------


def test_prospect_needs_at_least_one_name(db_session: Session) -> None:
    add_prospect(db_session, first_name=None, last_name="Seulement-Nom")

    with rejected(db_session, "ck_prospects_has_name"):
        add_prospect(db_session, first_name=" ", last_name=None)


def test_do_not_contact_fields_must_be_consistent(db_session: Session) -> None:
    with rejected(db_session, "ck_prospects_do_not_contact_consistency"):
        add_prospect(db_session, contactability_status=ContactabilityStatus.DO_NOT_CONTACT)
    with rejected(db_session, "ck_prospects_do_not_contact_consistency"):
        add_prospect(db_session, do_not_contact_at=datetime.now(UTC))


def test_one_primary_email_per_prospect(db_session: Session) -> None:
    prospect, other = add_prospect(db_session), add_prospect(db_session, first_name="Marie")
    add_email(db_session, prospect, "jean.test@example.com", is_primary=True)
    add_email(db_session, prospect, "j.test@example.org")
    add_email(db_session, other, "marie.test@example.com", is_primary=True)

    with rejected(db_session, "uq_emails_prospect_id_primary"):
        add_email(db_session, prospect, "jean.autre@example.net", is_primary=True)


def test_primary_email_must_be_active_and_former_addresses_are_kept(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    former = add_email(db_session, prospect, "jean.test@ancienne.example", is_primary=True)

    with rejected(db_session, "ck_emails_primary_is_active"):
        add_email(db_session, prospect, "inactif@example.com", is_primary=True, is_active=False)

    former.is_primary, former.is_active = False, False
    db_session.flush()
    add_email(db_session, prospect, "jean.test@nouvelle.example", is_primary=True)
    assert count(db_session, Email) == 2


def test_email_address_is_unique_per_prospect_only(db_session: Session) -> None:
    prospect, other = add_prospect(db_session), add_prospect(db_session, first_name="Homonyme")
    add_email(db_session, prospect, "contact@example.com")
    add_email(db_session, other, "contact@example.com")

    with rejected(db_session, "uq_emails_prospect_id_address"):
        add_email(db_session, prospect, "contact@example.com")


def test_email_address_is_stored_normalized(db_session: Session) -> None:
    prospect = add_prospect(db_session)

    with rejected(db_session, "ck_emails_address_format"):
        add_email(db_session, prospect, "Jean.Test@Example.com")
    with rejected(db_session, "ck_emails_address_format"):
        add_email(db_session, prospect, "pas-une-adresse")


def test_one_primary_phone_per_prospect_and_normalized_numbers(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    add_phone(db_session, prospect, "0200000001", is_primary=True)
    add_phone(db_session, prospect, "+33600000002")

    with rejected(db_session, "uq_phones_prospect_id_primary"):
        add_phone(db_session, prospect, "0200000003", is_primary=True)
    with rejected(db_session, "ck_phones_number_format"):
        add_phone(db_session, prospect, "02 00 00 00 04")


# --- contact tracking -------------------------------------------------------------------------


def test_one_contact_tracking_row_per_prospect(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    db_session.add(ContactTracking(prospect_id=prospect.id))
    db_session.flush()

    with rejected(db_session, "uq_contact_tracking_prospect_id"):
        db_session.add(ContactTracking(prospect_id=prospect.id))


def test_do_not_contact_is_not_a_tracking_status(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    db_session.add(ContactTracking(prospect_id=prospect.id))
    db_session.flush()

    with rejected(db_session, "ck_contact_tracking_status"):
        db_session.execute(text("UPDATE contact_tracking SET status = 'do_not_contact'"))


# --- deletion rules ---------------------------------------------------------------------------


def test_deleting_a_prospect_removes_its_owned_records(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    add_email(db_session, prospect, "jean.test@example.com")
    add_phone(db_session, prospect, "0200000001")
    batch = ImportBatch(filename="synthetique.xlsx", actor_type=OPERATOR.type, actor_display="Test")
    db_session.add(batch)
    db_session.flush()
    tracking = ContactTracking(prospect_id=prospect.id)
    db_session.add_all(
        [
            tracking,
            ProspectSource(prospect_id=prospect.id, source_type=ProspectSourceType.MANUAL),
            ImportRowMetadata(
                import_batch_id=batch.id,
                source_sheet="Feuille",
                source_row_number=2,
                prospect_id=prospect.id,
                legacy_metadata={"Colonne inconnue": "valeur"},
            ),
        ]
    )
    db_session.flush()
    db_session.add(
        ContactTrackingStatusHistory(
            contact_tracking_id=tracking.id,
            to_status=ContactTrackingStatus.TO_CONTACT,
            actor_type=OPERATOR.type,
            actor_display=OPERATOR.display,
        )
    )
    db_session.flush()

    db_session.execute(delete(Prospect).where(Prospect.id == prospect.id))

    owned = (Email, Phone, ContactTracking, ContactTrackingStatusHistory, ProspectSource)
    assert [count(db_session, model) for model in owned] == [0] * len(owned)
    assert count(db_session, ImportRowMetadata) == 0
    assert count(db_session, ImportBatch) == 1


def test_import_batch_cited_as_provenance_cannot_be_deleted(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    batch = ImportBatch(filename="synthetique.xlsx", actor_type=OPERATOR.type, actor_display="Test")
    db_session.add(batch)
    db_session.flush()
    db_session.add(
        ProspectSource(
            prospect_id=prospect.id,
            source_type=ProspectSourceType.EXCEL_IMPORT,
            import_batch_id=batch.id,
        )
    )
    db_session.flush()

    with rejected(db_session, "fk_prospect_sources_import_batch_id_import_batches"):
        db_session.execute(delete(ImportBatch).where(ImportBatch.id == batch.id))


# --- imports ----------------------------------------------------------------------------------


def test_import_batch_committed_at_matches_status(db_session: Session) -> None:
    batch = ImportBatch(filename="synthetique.xlsx", actor_type=OPERATOR.type, actor_display="Test")
    db_session.add(batch)
    db_session.flush()
    assert batch.status is ImportBatchStatus.PENDING
    assert batch.sheet_names == []

    with rejected(db_session, "ck_import_batches_committed_at_consistency"):
        batch.status = ImportBatchStatus.COMMITTED


def test_import_row_metadata_is_unique_per_batch_row(db_session: Session) -> None:
    batch = ImportBatch(filename="synthetique.xlsx", actor_type=OPERATOR.type, actor_display="Test")
    db_session.add(batch)
    db_session.flush()
    db_session.add(
        ImportRowMetadata(import_batch_id=batch.id, source_sheet="Feuille", source_row_number=2)
    )
    db_session.flush()

    with rejected(db_session, "uq_import_row_metadata_batch_sheet_row"):
        db_session.add(
            ImportRowMetadata(import_batch_id=batch.id, source_sheet="Feuille", source_row_number=2)
        )


# --- triggers ---------------------------------------------------------------------------------


def test_updated_at_is_maintained_by_the_database(db_session: Session) -> None:
    company = add_company(db_session)
    past = datetime(2000, 1, 1, tzinfo=UTC)
    db_session.execute(
        text("UPDATE companies SET created_at = :past, updated_at = :past"), {"past": past}
    )
    assert db_session.execute(select(Company.updated_at)).scalar_one() > past

    db_session.execute(update(Company).where(Company.id == company.id).values(size_label="PME"))
    created_at, updated_at = db_session.execute(
        select(Company.created_at, Company.updated_at)
    ).one()
    assert created_at == past
    assert updated_at > past


def test_audit_log_is_append_only(db_session: Session) -> None:
    entry = AuditLogEntry(
        actor_type=OPERATOR.type,
        actor_id=OPERATOR.id,
        actor_display=OPERATOR.display,
        entity_type="company",
        action="create",
    )
    db_session.add(entry)
    db_session.flush()
    assert entry.occurred_at is not None
    assert entry.changes == {}

    with rejected(db_session, "audit_log is append-only: UPDATE"):
        db_session.execute(update(AuditLogEntry).values(action="altered"))
    with rejected(db_session, "audit_log is append-only: DELETE"):
        db_session.execute(delete(AuditLogEntry))
    with rejected(db_session, "audit_log is append-only: TRUNCATE"):
        db_session.execute(text("TRUNCATE audit_log"))
    assert count(db_session, AuditLogEntry) == 1
