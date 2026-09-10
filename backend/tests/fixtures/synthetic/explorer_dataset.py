"""Deterministic synthetic dataset for Database Explorer tests and the Playwright backend.

Every value is invented: `example.com` addresses, `+331000…` numbers, zero-padded SIREN/SIRET that
no real company carries, fictitious names. Enough rows for several grid pages and every column
kind (text, enum, integer, boolean, timestamps, UUID keys and FKs, JSONB, text arrays).
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models import (
    AuditLogEntry,
    CommercialSegment,
    Company,
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
    ActivityStatus,
    ContactabilityStatus,
    ContactTrackingStatus,
    ImportBatchStatus,
    OriginType,
    PhoneType,
    ProspectSourceType,
    VerificationStatus,
)
from app.seed import seed_taxonomies
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from tests.builders import OPERATOR

COMPANY_COUNT = 36
PROSPECT_COUNT = 240
ACTIVITIES = ("Transports", "Logistique", "Messagerie", "Entrepôts", "Fret", "Affrètement")
NAMES = ("Exemple", "Démo", "Fictif", "Test", "Modèle", "Essai")
FORMS = ("SARL", "SAS", "SA")
FIRST_NAMES = ("Jean", "Marie", "Luc", "Claire", "Paul", "Sophie", "Hugo", "Emma")
LAST_NAMES = ("Test", "Exemple", "Démo", "Fictif", "Modèle", "Essai")
CITIES = ("Lyon", "Nantes", "Lille", "Rennes", "Dijon")
STATUSES = tuple(ContactTrackingStatus)
REFERENCE_TIME = datetime(2026, 9, 1, 9, 30, tzinfo=UTC)
LONG_APPROACH = " ".join(
    f"Paragraphe fictif {n} : approche commerciale synthétique décrite en détail pour tester"
    " l'affichage des valeurs longues dans l'explorateur de données."
    for n in range(1, 9)
)


@dataclass(frozen=True, slots=True)
class ExplorerDataset:
    companies: list[Company]  # companies[0] carries the long `client_approach` text
    prospects: list[Prospect]


def _ascii(text: str) -> str:
    return text.lower().replace("é", "e").replace("è", "e").replace("ô", "o")


def seed_explorer_dataset(session: Session) -> ExplorerDataset:
    seed_taxonomies(session)
    roles = list(session.scalars(select(Role).order_by(Role.slug)))
    segments = list(session.scalars(select(CommercialSegment).order_by(CommercialSegment.slug)))
    referents = [
        InternalReferent(
            first_name="Camille", last_name="Référente", email="camille.ref@example.com"
        ),
        InternalReferent(first_name="Alex", last_name="Exemple", email=None),
    ]
    session.add_all(referents)

    companies = []
    for i in range(COMPANY_COUNT):
        activity = ACTIVITIES[i % len(ACTIVITIES)]
        name = NAMES[(i // len(ACTIVITIES)) % len(NAMES)]
        company = Company(
            display_name=f"{activity} {name} {FORMS[i % len(FORMS)]}",
            legal_name=f"{activity} {name} Synthétique" if i % 3 else None,
            siren=f"{i + 1:09d}" if i % 4 else None,
            website_url=f"https://societe{i + 1}.example.com",
            email_domain=f"societe{i + 1}.example.com",
            size_label=("10-49", "50-249", None)[i % 3],
            commercial_segment_id=segments[i % len(segments)].id if i % 5 else None,
            client_approach=LONG_APPROACH
            if i == 0
            else ("Approche fictive courte" if i % 2 else None),
        )
        companies.append(company)
    session.add_all(companies)
    session.flush()

    for i, company in enumerate(companies):
        session.add(
            Establishment(
                company_id=company.id,
                name=f"Site principal {i + 1}",
                siret=f"{i + 1:014d}",
                address_line1=f"{i + 1} rue de l'Exemple",
                postal_code=f"{10000 + i * 7}",
                city=CITIES[i % len(CITIES)],
                country="France",
                kind="siège",
                is_primary=True,
            )
        )

    prospects = []
    for i in range(PROSPECT_COUNT):
        first = FIRST_NAMES[i % len(FIRST_NAMES)]
        last = LAST_NAMES[(i // len(FIRST_NAMES)) % len(LAST_NAMES)]
        blocked = i % 37 == 5
        prospect = Prospect(
            company_id=companies[i % COMPANY_COUNT].id,
            first_name=first,
            last_name=last,
            role_id=roles[i % len(roles)].id if i % 3 else None,
            exact_job_title=f"Poste fictif {i % 12 + 1}",
            activity_status=tuple(ActivityStatus)[i % 3],
            employment_verified_at=REFERENCE_TIME - timedelta(days=i) if i % 2 else None,
            contactability_status=ContactabilityStatus.DO_NOT_CONTACT
            if blocked
            else ContactabilityStatus.CONTACTABLE,
            do_not_contact_at=REFERENCE_TIME if blocked else None,
            do_not_contact_reason="Opposition fictive" if blocked else None,
        )
        prospects.append(prospect)
    session.add_all(prospects)
    session.flush()

    for i, prospect in enumerate(prospects):
        local = f"{_ascii(prospect.first_name or '')}.{_ascii(prospect.last_name or '')}{i + 1}"
        session.add(
            Email(
                prospect_id=prospect.id,
                address=f"{local}@example.com",
                is_primary=True,
                verification_status=tuple(VerificationStatus)[i % 4],
                origin_type=OriginType.IMPORTED,
            )
        )
        if i % 3 == 0:
            session.add(
                Phone(
                    prospect_id=prospect.id,
                    number=f"+3310000{i + 1:04d}",
                    type=PhoneType.LANDLINE,
                    origin_type=OriginType.MANUAL,
                )
            )
        if i % 4 == 0:
            save_contact_tracking(
                session,
                OPERATOR,
                prospect.id,
                ContactTrackingInput(
                    status=STATUSES[i % len(STATUSES)],
                    planned_contact_at=REFERENCE_TIME + timedelta(days=i % 30),
                    referent_id=referents[i % 2].id,
                ),
            )

    batch = ImportBatch(
        filename="classeur-synthetique.xlsx",
        sheet_names=["Feuille synthétique", "Notes"],
        status=ImportBatchStatus.COMMITTED,
        rows_total=20,
        rows_imported=20,
        committed_at=REFERENCE_TIME,
        actor_type=ActorType.IMPORT,
        actor_display="Import synthétique",
    )
    session.add(batch)
    session.flush()
    for i, prospect in enumerate(prospects[:20]):
        session.add(
            ProspectSource(
                prospect_id=prospect.id,
                source_type=ProspectSourceType.EXCEL_IMPORT,
                source_reference=f"Feuille synthétique!L{i + 2}",
                import_batch_id=batch.id,
            )
        )
        session.add(
            ImportRowMetadata(
                import_batch_id=batch.id,
                source_sheet="Feuille synthétique",
                source_row_number=i + 2,
                prospect_id=prospect.id,
                company_id=prospect.company_id,
                legacy_metadata={
                    "Colonne inconnue": f"valeur fictive {i + 1}",
                    "Remarques": LONG_APPROACH if i == 0 else "RAS",
                },
            )
        )
    for i, company in enumerate(companies[:5]):
        session.add(
            AuditLogEntry(
                actor_type=ActorType.HUMAN,
                actor_id="test-user",
                actor_display=OPERATOR.display,
                entity_type="company",
                entity_id=company.id,
                action="update",
                changes={
                    "display_name": {"before": f"Ancien nom {i + 1}", "after": company.display_name}
                },
            )
        )
    session.flush()
    return ExplorerDataset(companies=companies, prospects=prospects)
