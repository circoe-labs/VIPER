"""Import fields and the historical workbook layout — the only place knowing legacy column names.

Domain services never see these names (overview, *Import/export adapters*); Task 10's export can
reuse `LEGACY_LAYOUT` for its compatibility columns.
"""

from dataclasses import dataclass
from enum import StrEnum

from app.services.imports.text import fold


class ImportField(StrEnum):
    """A target of the column mapping. Values are stable keys (API, legacy metadata)."""

    VERIFICATION_STATUS = "verification_status"
    REFERENT = "referent"
    PLANNED_CONTACT = "planned_contact"
    COMPANY_NAME = "company_name"
    STAGE_APPOINTMENT = "stage_appointment"
    STAGE_QUOTE_SENT = "stage_quote_sent"
    STAGE_QUOTE_FOLLOW_UP = "stage_quote_follow_up"
    STAGE_FOLLOW_UP_1 = "stage_follow_up_1"
    STAGE_FOLLOW_UP_2 = "stage_follow_up_2"
    CONTACT_MODE = "contact_mode"
    CATEGORY = "category"
    CIVILITY = "civility"
    LAST_NAME = "last_name"
    FIRST_NAME = "first_name"
    JOB_TITLE = "job_title"
    EMAIL = "email"
    PHONE = "phone"
    MOBILE = "mobile"
    ADDRESS = "address"
    PROJECT_DONE = "project_done_with_circoe"
    PROJECT_TYPE = "project_type"
    CIRCOE_REFERENCES = "circoe_references"
    CLIENT_APPROACH = "client_approach"
    LEGACY_TO_CONTACT_FLAG = "legacy_to_contact_flag"


@dataclass(frozen=True, slots=True)
class FieldSpec:
    field: ImportField
    header: str
    label: str
    aliases: tuple[str, ...] = ()
    key: bool = False
    opaque: bool = False
    repeat: ImportField | None = None
    max_length: int | None = None


LEGACY_LAYOUT: tuple[FieldSpec, ...] = (
    FieldSpec(
        ImportField.VERIFICATION_STATUS,
        "Statut_verification",
        "Statut de vérification",
        ("Statut vérification", "Statut verification"),
        opaque=True,
    ),
    FieldSpec(ImportField.REFERENT, "Référent", "Référent", ("referents",)),
    FieldSpec(
        ImportField.PLANNED_CONTACT,
        "A contacter ",
        "A contacter (semaine)",
        ("à contacter", "semaine de contact"),
        repeat=ImportField.LEGACY_TO_CONTACT_FLAG,
    ),
    FieldSpec(
        ImportField.COMPANY_NAME,
        "Entreprise",
        "Entreprise",
        ("société", "raison sociale", "company"),
        key=True,
        max_length=255,
    ),
    FieldSpec(
        ImportField.STAGE_APPOINTMENT, "rdv obtenu", "RDV obtenu", ("rendez-vous obtenu", "rdv")
    ),
    FieldSpec(ImportField.STAGE_QUOTE_SENT, "Devis envoyé", "Devis envoyé", ("devis",)),
    FieldSpec(ImportField.STAGE_QUOTE_FOLLOW_UP, "Suivi", "Suivi"),
    FieldSpec(ImportField.STAGE_FOLLOW_UP_1, "Relance 1", "Relance 1", ("relance1",)),
    FieldSpec(ImportField.STAGE_FOLLOW_UP_2, "relance 2", "Relance 2", ("relance2",)),
    FieldSpec(ImportField.CONTACT_MODE, "Mode de contact", "Mode de contact", opaque=True),
    FieldSpec(ImportField.CATEGORY, "Catégorie", "Catégorie", ("catégories",)),
    FieldSpec(ImportField.CIVILITY, "Civilité ", "Civilité"),
    FieldSpec(ImportField.LAST_NAME, "Nom", "Nom", ("nom de famille",), key=True, max_length=100),
    FieldSpec(ImportField.FIRST_NAME, "Prénom", "Prénom", key=True, max_length=100),
    FieldSpec(
        ImportField.JOB_TITLE,
        "Fonction",
        "Fonction",
        ("poste", "intitulé de poste", "intitulé exact"),
        max_length=255,
    ),
    FieldSpec(
        ImportField.EMAIL,
        "Mail",
        "Mail",
        ("e-mail", "email", "adresse mail", "adresse e-mail", "courriel"),
        key=True,
    ),
    FieldSpec(ImportField.PHONE, "Téléphone", "Téléphone", ("tél", "tel", "téléphone fixe")),
    FieldSpec(ImportField.MOBILE, "Mobile", "Mobile", ("portable", "téléphone mobile", "gsm")),
    FieldSpec(ImportField.ADDRESS, "Adresse ", "Adresse"),
    FieldSpec(
        ImportField.PROJECT_DONE,
        "Projet déjà réalisé avec l'entreprise",
        "Projet déjà réalisé avec l'entreprise",
    ),
    FieldSpec(ImportField.PROJECT_TYPE, "Type de projet", "Type de projet"),
    FieldSpec(
        ImportField.CIRCOE_REFERENCES,
        "Liste des fiches projets_references_CIRCOE.csv",
        "Références CIRCOE",
        ("références circoe",),
    ),
    FieldSpec(ImportField.CLIENT_APPROACH, "Approche client", "Approche client"),
    FieldSpec(
        ImportField.LEGACY_TO_CONTACT_FLAG,
        "A contacter",
        "A contacter (seconde colonne)",
        opaque=True,
    ),
)

SPECS: dict[ImportField, FieldSpec] = {spec.field: spec for spec in LEGACY_LAYOUT}
FIELD_BY_HEADER: dict[str, ImportField] = {
    fold(name): spec.field
    for spec in LEGACY_LAYOUT
    if spec.field is not ImportField.LEGACY_TO_CONTACT_FLAG
    for name in (spec.header, *spec.aliases)
}
STAGE_FIELDS: tuple[ImportField, ...] = (
    ImportField.STAGE_APPOINTMENT,
    ImportField.STAGE_QUOTE_SENT,
    ImportField.STAGE_QUOTE_FOLLOW_UP,
    ImportField.STAGE_FOLLOW_UP_1,
    ImportField.STAGE_FOLLOW_UP_2,
)
CORRECTABLE_FIELDS: tuple[ImportField, ...] = (
    ImportField.COMPANY_NAME,
    ImportField.CIVILITY,
    ImportField.LAST_NAME,
    ImportField.FIRST_NAME,
    ImportField.JOB_TITLE,
    ImportField.EMAIL,
    ImportField.PHONE,
    ImportField.MOBILE,
    ImportField.ADDRESS,
    ImportField.PLANNED_CONTACT,
)
