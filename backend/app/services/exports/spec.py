"""The Excel export specification (Task 10, ADR-0013) — the only module knowing the workbook layout.

Sheets in order, each with its columns in order: French header, value getter, cell kind and width.
Changing the order, a header or a width means editing this module only: nothing is stored per
column and no migration is involved. Getters read the normalized domain (`projection`), never the
cached import rows; raw legacy values appear only in the `Données d'origine` sheet.

Default order of the main sheet (grill section C priorities): Référent first; then contact planning
and company; classification; identity, role, activity/verification and the primary channels;
company context (address, identifiers, Circoe texts); contact tracking and opposition; provenance;
the stable ids that key the other sheets. Secondary sheets start with their key.
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date, datetime
from enum import StrEnum
from typing import Any, Protocol

from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactTrackingStatus,
    OriginType,
    PhoneType,
    ProspectSourceType,
    VerificationStatus,
)
from app.models.taxonomies import InternalReferent
from app.services.exports.projection import (
    CompanyRecord,
    EmailRecord,
    EstablishmentRecord,
    ExportData,
    LegacyRecord,
    PhoneRecord,
    ProspectRecord,
    SourceRecord,
)
from app.services.import_commit import BUSINESS_TIMEZONE
from app.services.imports.models import LegacyReason

type Value = str | int | float | bool | date | datetime | None


class Kind(StrEnum):
    TEXT = "text"  # a text cell (never a formula)
    CODE = "code"  # a text cell formatted as Text: digits keep leading zeros (phones, SIREN, ids)
    DATE = "date"  # a real date, calendar day in Europe/Paris
    DATETIME = "datetime"  # a real date and time in Europe/Paris (shown as a date at midnight)
    INTEGER = "integer"
    RAW = "raw"  # a preserved legacy value: text, number or boolean as stored


@dataclass(frozen=True, slots=True)
class Column[R]:
    header: str
    get: Callable[[R], Value]
    kind: Kind = Kind.TEXT
    width: int = 16


@dataclass(frozen=True, slots=True)
class Sheet[R]:
    key: str  # stable technical name (counts, audit)
    name: str  # sheet tab
    columns: tuple[Column[R], ...]
    rows: Callable[[ExportData], Iterable[R]]


# --- French labels ----------------------------------------------------------------------------

CIVILITY = {Civility.MR: "M.", Civility.MS: "Mme"}
ACTIVITY = {
    ActivityStatus.ACTIVE: "Actif",
    ActivityStatus.INACTIVE: "Inactif",
    ActivityStatus.UNKNOWN: "Inconnu",
}
TRACKING_STATUS = {
    ContactTrackingStatus.TO_CONTACT: "À contacter",
    ContactTrackingStatus.CONTACTED: "Contacté",
    ContactTrackingStatus.FOLLOW_UP_1: "Relance 1",
    ContactTrackingStatus.FOLLOW_UP_2: "Relance 2",
    ContactTrackingStatus.RESPONSE_RECEIVED: "Réponse reçue",
    ContactTrackingStatus.APPOINTMENT_OBTAINED: "RDV obtenu",
    ContactTrackingStatus.QUOTE_SENT: "Devis envoyé",
    ContactTrackingStatus.QUOTE_FOLLOW_UP: "Suivi du devis",
    ContactTrackingStatus.WON: "Gagné",
    ContactTrackingStatus.NOT_INTERESTED: "Non intéressé",
}
PHONE_TYPE = {PhoneType.MOBILE: "Mobile", PhoneType.LANDLINE: "Fixe", PhoneType.OTHER: "Autre"}
VERIFICATION = {
    VerificationStatus.UNVERIFIED: "Non vérifié",
    VerificationStatus.VERIFIED: "Vérifié",
    VerificationStatus.INVALID: "Invalide",
    VerificationStatus.UNKNOWN: "Inconnu",
}
ORIGIN = {
    OriginType.IMPORTED: "Import",
    OriginType.MANUAL: "Saisie manuelle",
    OriginType.PUBLISHED: "Source publique",
    OriginType.INFERRED: "Déduction",
    OriginType.OTHER: "Autre",
}
SOURCE_TYPE = {
    ProspectSourceType.EXCEL_IMPORT: "Import Excel",
    ProspectSourceType.MANUAL: "Saisie manuelle",
    ProspectSourceType.FUTURE_AGENT: "Agent",
    ProspectSourceType.OTHER: "Autre",
}
LEGACY_REASON = {
    LegacyReason.OPAQUE_FIELD.value: "Conservée telle quelle",
    LegacyReason.UNMAPPED_COLUMN.value: "Colonne non reconnue",
    LegacyReason.NOT_MAPPED_VALUE.value: "Non reprise telle quelle",
    LegacyReason.CORRECTED.value: "Valeur d'origine, corrigée",
}


def yes_no(flag: bool) -> str:
    return "Oui" if flag else "Non"


def full_name(referent: InternalReferent | None) -> str | None:
    return f"{referent.first_name} {referent.last_name}" if referent else None


def week_label(moment: datetime | None) -> str | None:
    """ISO week of the planned contact in Europe/Paris, e.g. `S37 2026` (week-numbering year)."""
    if moment is None:
        return None
    year, week, _ = moment.astimezone(BUSINESS_TIMEZONE).isocalendar()
    return f"S{week:02d} {year}"


def joined(parts: Iterable[str | None], separator: str = ", ") -> str | None:
    return separator.join(part for part in parts if part) or None


# --- company context (Prospects and Entreprises sheets) ----------------------------------------

type CompanyGetter = Callable[[CompanyRecord], Value]


def segment(record: CompanyRecord) -> Value:
    return record.segment.label if record.segment else None


def categories(record: CompanyRecord) -> Value:
    return joined((row.label for row in record.categories), "; ")


def street(record: CompanyRecord) -> Value:
    site = record.primary_establishment
    return joined((site.address_line1, site.address_line2)) if site else None


def postal_code(record: CompanyRecord) -> Value:
    site = record.primary_establishment
    return site.postal_code if site else None


def city(record: CompanyRecord) -> Value:
    site = record.primary_establishment
    return site.city if site else None


def country(record: CompanyRecord) -> Value:
    site = record.primary_establishment
    return site.country if site else None


def of_company(get: CompanyGetter) -> Callable[[ProspectRecord], Value]:
    return lambda record: get(record.company) if record.company else None


# --- sheets -----------------------------------------------------------------------------------

type P = ProspectRecord

PROSPECT_COLUMNS: tuple[Column[P], ...] = (
    # Referent: the internal Circoe person only — legacy markers never reach this column.
    Column[P]("Référent", lambda r: full_name(r.referent), width=22),
    # Contact planning: the real date and its derived ISO week.
    Column[P](
        "Date de contact prévue",
        lambda r: r.tracking.planned_contact_at if r.tracking else None,
        Kind.DATE,
        14,
    ),
    Column[P](
        "Semaine",
        lambda r: week_label(r.tracking.planned_contact_at if r.tracking else None),
        width=11,
    ),
    Column[P]("Entreprise", of_company(lambda c: c.company.display_name), width=30),
    # Classification.
    Column[P]("Segment commercial", of_company(segment), width=20),
    Column[P]("Catégories d'activité", of_company(categories), width=32),
    # Identity, role, activity and employment verification (separate concepts).
    Column[P](
        "Civilité",
        lambda r: CIVILITY[r.prospect.civility] if r.prospect.civility else None,
        width=9,
    ),
    Column[P]("Nom", lambda r: r.prospect.last_name, width=18),
    Column[P]("Prénom", lambda r: r.prospect.first_name, width=16),
    Column[P]("Rôle", lambda r: r.role.label if r.role else None, width=22),
    Column[P]("Intitulé exact", lambda r: r.prospect.exact_job_title, width=28),
    Column[P]("Statut activité", lambda r: ACTIVITY[r.prospect.activity_status], width=14),
    Column[P]("Date de vérification", lambda r: r.prospect.employment_verified_at, Kind.DATE, 14),
    # Primary channels (compatibility columns); every alias is in the E-mails / Téléphones sheets.
    Column[P]("E-mail", lambda r: r.primary_email.address if r.primary_email else None, width=32),
    Column[P](
        "Téléphone",
        lambda r: r.primary_phone.number if r.primary_phone else None,
        Kind.CODE,
        16,
    ),
    Column[P](
        "Type de téléphone",
        lambda r: PHONE_TYPE[r.primary_phone.type] if r.primary_phone else None,
        width=12,
    ),
    # Company context: primary establishment, identifiers, Circoe texts.
    Column[P]("Adresse", of_company(street), width=32),
    Column[P]("Code postal", of_company(postal_code), Kind.CODE, 11),
    Column[P]("Ville", of_company(city), width=18),
    Column[P]("SIREN", of_company(lambda c: c.company.siren), Kind.CODE, 12),
    Column[P]("Site web", of_company(lambda c: c.company.website_url), width=28),
    Column[P]("Domaine e-mail", of_company(lambda c: c.company.email_domain), width=22),
    Column[P](
        "Projet déjà réalisé avec l'entreprise",
        of_company(lambda c: c.company.project_done_with_circoe),
        width=28,
    ),
    Column[P]("Type de projet", of_company(lambda c: c.company.project_type), width=24),
    Column[P]("Références Circoe", of_company(lambda c: c.company.circoe_references), width=28),
    Column[P]("Approche client", of_company(lambda c: c.company.client_approach), width=28),
    # Contact tracking: one status label and its dates, instead of five legacy booleans.
    Column[P](
        "Suivi de contact",
        lambda r: TRACKING_STATUS[r.tracking.status] if r.tracking else None,
        width=18,
    ),
    Column[P]("Statut depuis le", lambda r: r.status_since, Kind.DATE, 14),
    Column[P](
        "Date de réponse",
        lambda r: r.tracking.response_received_at if r.tracking else None,
        Kind.DATE,
        14,
    ),
    Column[P](
        "Date de rendez-vous",
        lambda r: r.tracking.appointment_at if r.tracking else None,
        Kind.DATETIME,
        16,
    ),
    # Durable opposition, distinct from the `Non intéressé` outcome above.
    Column[P](
        "Ne pas contacter",
        lambda r: yes_no(r.prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT),
        width=14,
    ),
    Column[P]("Date d'opposition", lambda r: r.prospect.do_not_contact_at, Kind.DATE, 14),
    Column[P]("Motif d'opposition", lambda r: r.prospect.do_not_contact_reason, width=28),
    # Provenance summary: the oldest source (all of them in the Provenance sheet).
    Column[P](
        "Origine",
        lambda r: SOURCE_TYPE[r.sources[0].source_type] if r.sources else None,
        width=16,
    ),
    Column[P](
        "Collecté le", lambda r: r.sources[0].collected_at if r.sources else None, Kind.DATE, 14
    ),
    Column[P](
        "Base légale ou contexte de collecte",
        lambda r: r.sources[0].legal_basis_or_collection_context if r.sources else None,
        width=34,
    ),
    Column[P]("ID VIPER", lambda r: str(r.prospect.id), Kind.CODE, 38),
    Column[P](
        "ID entreprise",
        lambda r: str(r.company.company.id) if r.company else None,
        Kind.CODE,
        38,
    ),
)

type C = CompanyRecord

COMPANY_COLUMNS: tuple[Column[C], ...] = (
    Column[C]("ID entreprise", lambda c: str(c.company.id), Kind.CODE, 38),
    Column[C]("Entreprise", lambda c: c.company.display_name, width=30),
    Column[C]("Raison sociale", lambda c: c.company.legal_name, width=30),
    Column[C]("SIREN", lambda c: c.company.siren, Kind.CODE, 12),
    Column[C]("Segment commercial", segment, width=20),
    Column[C]("Catégories d'activité", categories, width=32),
    Column[C]("Taille", lambda c: c.company.size_label, width=16),
    Column[C]("Site web", lambda c: c.company.website_url, width=28),
    Column[C]("Domaine e-mail", lambda c: c.company.email_domain, width=22),
    Column[C]("Adresse", street, width=32),
    Column[C]("Code postal", postal_code, Kind.CODE, 11),
    Column[C]("Ville", city, width=18),
    Column[C]("Pays", country, width=14),
    Column[C]("Établissements", lambda c: len(c.establishments), Kind.INTEGER, 14),
    Column[C]("Prospects", lambda c: c.prospect_count, Kind.INTEGER, 11),
    Column[C](
        "Projet déjà réalisé avec l'entreprise",
        lambda c: c.company.project_done_with_circoe,
        width=28,
    ),
    Column[C]("Type de projet", lambda c: c.company.project_type, width=24),
    Column[C]("Références Circoe", lambda c: c.company.circoe_references, width=28),
    Column[C]("Approche client", lambda c: c.company.client_approach, width=28),
)

type S = EstablishmentRecord

ESTABLISHMENT_COLUMNS: tuple[Column[S], ...] = (
    Column[S]("ID entreprise", lambda s: str(s.company.company.id), Kind.CODE, 38),
    Column[S]("Entreprise", lambda s: s.company.company.display_name, width=30),
    Column[S]("Établissement", lambda s: s.establishment.name, width=26),
    Column[S]("Principal", lambda s: yes_no(s.establishment.is_primary), width=10),
    Column[S]("Type", lambda s: s.establishment.kind, width=14),
    Column[S]("SIRET", lambda s: s.establishment.siret, Kind.CODE, 16),
    Column[S]("Adresse ligne 1", lambda s: s.establishment.address_line1, width=30),
    Column[S]("Adresse ligne 2", lambda s: s.establishment.address_line2, width=24),
    Column[S]("Code postal", lambda s: s.establishment.postal_code, Kind.CODE, 11),
    Column[S]("Ville", lambda s: s.establishment.city, width=18),
    Column[S]("Pays", lambda s: s.establishment.country, width=14),
    Column[S]("ID établissement", lambda s: str(s.establishment.id), Kind.CODE, 38),
)


class Owned(Protocol):
    @property
    def owner(self) -> ProspectRecord: ...


def owner_columns[R: Owned](_: type[R]) -> tuple[Column[R], ...]:
    """The prospect a secondary row belongs to: its key, then readable names."""
    return (
        Column[R]("ID VIPER", lambda row: str(row.owner.prospect.id), Kind.CODE, 38),
        Column[R]("Nom", lambda row: row.owner.prospect.last_name, width=18),
        Column[R]("Prénom", lambda row: row.owner.prospect.first_name, width=16),
        Column[R](
            "Entreprise",
            lambda row: row.owner.company.company.display_name if row.owner.company else None,
            width=26,
        ),
    )


type E = EmailRecord

EMAIL_COLUMNS: tuple[Column[E], ...] = (
    *owner_columns(EmailRecord),
    Column[E]("E-mail", lambda e: e.email.address, width=34),
    Column[E]("Principal", lambda e: yes_no(e.email.is_primary), width=10),
    Column[E]("Actif", lambda e: yes_no(e.email.is_active), width=8),
    Column[E]("Vérification", lambda e: VERIFICATION[e.email.verification_status], width=13),
    Column[E]("Vérifié le", lambda e: e.email.last_verified_at, Kind.DATE, 13),
    Column[E]("Origine", lambda e: ORIGIN[e.email.origin_type], width=16),
    Column[E]("Référence de la source", lambda e: e.email.source_reference, width=34),
)

type T = PhoneRecord

PHONE_COLUMNS: tuple[Column[T], ...] = (
    *owner_columns(PhoneRecord),
    Column[T]("Numéro", lambda t: t.phone.number, Kind.CODE, 16),
    Column[T]("Type", lambda t: PHONE_TYPE[t.phone.type], width=10),
    Column[T]("Principal", lambda t: yes_no(t.phone.is_primary), width=10),
    Column[T]("Actif", lambda t: yes_no(t.phone.is_active), width=8),
    Column[T]("Vérification", lambda t: VERIFICATION[t.phone.verification_status], width=13),
    Column[T]("Vérifié le", lambda t: t.phone.last_verified_at, Kind.DATE, 13),
    Column[T]("Origine", lambda t: ORIGIN[t.phone.origin_type], width=16),
    Column[T]("Référence de la source", lambda t: t.phone.source_reference, width=34),
)

type V = SourceRecord

SOURCE_COLUMNS: tuple[Column[V], ...] = (
    *owner_columns(SourceRecord),
    Column[V]("Origine", lambda v: SOURCE_TYPE[v.source.source_type], width=16),
    Column[V]("Collecté le", lambda v: v.source.collected_at, Kind.DATE, 13),
    Column[V](
        "Base légale ou contexte de collecte",
        lambda v: v.source.legal_basis_or_collection_context,
        width=34,
    ),
    Column[V]("Référence de la source", lambda v: v.source.source_reference, width=34),
    Column[V]("Fichier importé", lambda v: v.batch.filename if v.batch else None, width=26),
    Column[V]("Enregistré par", lambda v: v.source.actor_display, width=22),
    Column[V]("Notes", lambda v: v.source.notes, width=28),
)

type L = LegacyRecord

LEGACY_COLUMNS: tuple[Column[L], ...] = (
    Column[L]("ID VIPER", lambda x: str(x.owner.prospect.id) if x.owner else None, Kind.CODE, 38),
    Column[L]("Nom", lambda x: x.owner.prospect.last_name if x.owner else None, width=18),
    Column[L]("Prénom", lambda x: x.owner.prospect.first_name if x.owner else None, width=16),
    Column[L]("Fichier importé", lambda x: x.batch.filename, width=26),
    Column[L]("Importé le", lambda x: x.batch.committed_at or x.batch.created_at, Kind.DATE, 13),
    Column[L]("Feuille", lambda x: x.trace.source_sheet, width=16),
    Column[L]("Ligne", lambda x: x.trace.source_row_number, Kind.INTEGER, 8),
    Column[L]("Colonne", lambda x: x.column, width=9),
    Column[L]("En-tête d'origine", lambda x: x.header, width=26),
    Column[L]("Champ", lambda x: x.key, width=22),
    Column[L]("Valeur d'origine", lambda x: x.value, Kind.RAW, 34),
    Column[L](
        "Motif",
        lambda x: LEGACY_REASON.get(x.reason, x.reason) if x.reason else None,
        width=24,
    ),
)

SHEETS: tuple[Sheet[Any], ...] = (
    Sheet[P]("prospects", "Prospects", PROSPECT_COLUMNS, lambda data: data.prospects),
    Sheet[C]("companies", "Entreprises", COMPANY_COLUMNS, lambda data: data.companies),
    Sheet[S](
        "establishments",
        "Établissements",
        ESTABLISHMENT_COLUMNS,
        lambda data: data.establishments(),
    ),
    Sheet[E]("emails", "E-mails", EMAIL_COLUMNS, lambda data: data.emails()),
    Sheet[T]("phones", "Téléphones", PHONE_COLUMNS, lambda data: data.phones()),
    Sheet[V]("sources", "Provenance", SOURCE_COLUMNS, lambda data: data.sources()),
    Sheet[L]("legacy_values", "Données d'origine", LEGACY_COLUMNS, lambda data: data.legacy),
)
