"""Diagnostic catalogue of the import engine: machine code, fixed severity, French message.

Severity: `error` — the row (or file) cannot be imported as is; `warning` — importable, review
recommended; `info` — what the engine did, for transparency. Messages never embed cell values
(only sheet names, column letters/headers and field labels); the offending raw value travels in
`Diagnostic.value`, so logs and counts can be produced without it.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum

from pydantic import BaseModel, ConfigDict

from app.services.errors import InvalidInputError
from app.services.imports.fields import ImportField
from app.services.imports.text import JsonScalar


class Severity(StrEnum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


class DiagnosticCode(StrEnum):
    FILE_EMPTY = "file.empty"
    FILE_TOO_LARGE = "file.too_large"
    FILE_UNSUPPORTED_FORMAT = "file.unsupported_format"
    FILE_ENCRYPTED = "file.encrypted"
    FILE_LEGACY_XLS = "file.legacy_xls"
    FILE_CORRUPT = "file.corrupt"
    FILE_ENCODING_UNKNOWN = "file.encoding_unknown"
    FILE_ENCODING_FALLBACK = "file.encoding_fallback"
    SHEET_TOO_MANY_ROWS = "sheet.too_many_rows"
    SHEET_TOO_MANY_COLUMNS = "sheet.too_many_columns"
    SHEET_NOT_FOUND = "sheet.not_found"
    SHEET_SKIPPED = "sheet.skipped"
    SHEET_MERGED_CELLS = "sheet.merged_cells"
    MAPPING_UNKNOWN_SHEET = "mapping.unknown_sheet"
    MAPPING_INVALID_HEADER_ROW = "mapping.invalid_header_row"
    MAPPING_UNKNOWN_COLUMN = "mapping.unknown_column"
    MAPPING_DUPLICATE_FIELD = "mapping.duplicate_field"
    COLUMN_UNMAPPED = "column.unmapped"
    COLUMN_UNNAMED = "column.unnamed"
    COLUMN_DUPLICATE_HEADER = "column.duplicate_header"
    COLUMN_LEGACY_PRESERVED = "column.legacy_preserved"
    COLUMN_MISSING_KEY = "column.missing_key"
    COLUMN_MISSING = "column.missing"
    CELL_MERGED_VALUE_COPIED = "cell.merged_value_copied"
    VALUE_TOO_LONG = "value.too_long"
    VALUE_ZERO_PLACEHOLDER = "value.zero_placeholder"
    PROSPECT_MISSING_NAME = "prospect.missing_name"
    PROSPECT_PARTIAL_NAME = "prospect.partial_name"
    COMPANY_MISSING = "company.missing"
    CIVILITY_INVALID = "civility.invalid"
    ROLE_SUGGESTED = "role.suggested"
    ROLE_UNMATCHED = "role.unmatched"
    ROLE_INACTIVE_MATCH = "role.inactive_match"
    CATEGORY_SUGGESTED = "category.suggested"
    CATEGORY_UNMATCHED = "category.unmatched"
    CATEGORY_INVALID = "category.invalid"
    CATEGORY_INACTIVE_MATCH = "category.inactive_match"
    CATEGORY_SEGMENT_SUGGESTED = "category.segment_suggested"
    REFERENT_MARKER = "referent.marker"
    REFERENT_EMAIL_LIKE = "referent.email_like"
    REFERENT_WEEK_MARKER = "referent.week_marker"
    REFERENT_NOTE = "referent.note"
    REFERENT_UNKNOWN = "referent.unknown"
    REFERENT_PARTIAL_MATCH = "referent.partial_match"
    REFERENT_AMBIGUOUS = "referent.ambiguous"
    REFERENT_INACTIVE = "referent.inactive"
    PLANNED_CONTACT_WEEK_WITHOUT_YEAR = "planned_contact.week_without_year"
    PLANNED_CONTACT_NOT_A_WEEK = "planned_contact.not_a_week"
    PLANNED_CONTACT_INVALID_WEEK = "planned_contact.invalid_week"
    ACTIVITY_INACTIVE_SUGGESTED = "activity.inactive_suggested"
    TRACKING_STAGE_CONFLICT = "tracking.stage_conflict"
    TRACKING_STAGE_UNRECOGNIZED = "tracking.stage_unrecognized"
    EMAIL_INVALID = "email.invalid"
    EMAIL_MULTIPLE_IN_CELL = "email.multiple_in_cell"
    PHONE_INVALID = "phone.invalid"
    PHONE_LEADING_ZERO_RESTORED = "phone.leading_zero_restored"
    PHONE_UNRECOGNIZED_FORMAT = "phone.unrecognized_format"
    PHONE_MULTIPLE_IN_CELL = "phone.multiple_in_cell"
    ADDRESS_UNSTRUCTURED = "address.unstructured"
    ADDRESS_WITHOUT_COMPANY = "address.without_company"
    COMPANY_FIELD_CONFLICT = "company.field_conflict"
    COMPANY_VARIANT_IN_FILE = "company.variant_in_file"
    COMPANY_EXISTING_MATCH = "company.existing_match"
    COMPANY_LIKELY_MATCH = "company.likely_match"
    DUPLICATE_EMAIL_IN_FILE = "duplicate.email_in_file"
    DUPLICATE_PERSON_IN_FILE = "duplicate.person_in_file"
    DUPLICATE_EMAIL_EXISTING = "duplicate.email_existing"
    DUPLICATE_PERSON_EXISTING = "duplicate.person_existing"
    DUPLICATE_PERSON_NAME_EXISTING = "duplicate.person_name_existing"
    CONTACTABILITY_DO_NOT_CONTACT = "contactability.do_not_contact"
    CONTACTABILITY_POSSIBLE_DO_NOT_CONTACT = "contactability.possible_do_not_contact"


@dataclass(frozen=True, slots=True)
class CodeSpec:
    severity: Severity
    message: str


ERROR, WARNING, INFO = Severity.ERROR, Severity.WARNING, Severity.INFO
KEPT = "valeur d'origine conservée"
NOT_REFERENT = f"ce n'est pas un référent interne ; {KEPT}."

CATALOGUE: dict[DiagnosticCode, CodeSpec] = {
    DiagnosticCode.FILE_EMPTY: CodeSpec(ERROR, "Le fichier est vide."),
    DiagnosticCode.FILE_TOO_LARGE: CodeSpec(
        ERROR, "Le fichier dépasse la taille maximale autorisée ({limit_mb} Mo)."
    ),
    DiagnosticCode.FILE_UNSUPPORTED_FORMAT: CodeSpec(
        ERROR, "Format non pris en charge : importez un classeur Excel (.xlsx) ou un fichier CSV."
    ),
    DiagnosticCode.FILE_ENCRYPTED: CodeSpec(
        ERROR,
        "Le classeur est protégé par un mot de passe : enregistrez-en une copie sans mot de passe"
        " puis importez-la.",
    ),
    DiagnosticCode.FILE_LEGACY_XLS: CodeSpec(
        ERROR,
        "Ancien format Excel 97-2003 (.xls) non pris en charge : enregistrez le fichier en .xlsx.",
    ),
    DiagnosticCode.FILE_CORRUPT: CodeSpec(ERROR, "Le fichier est illisible ou endommagé."),
    DiagnosticCode.FILE_ENCODING_UNKNOWN: CodeSpec(
        ERROR, "Encodage du fichier CSV non reconnu : enregistrez-le en UTF-8."
    ),
    DiagnosticCode.FILE_ENCODING_FALLBACK: CodeSpec(
        INFO, "Fichier CSV lu en Windows-1252 (il n'est pas en UTF-8) : vérifiez les accents."
    ),
    DiagnosticCode.SHEET_TOO_MANY_ROWS: CodeSpec(
        ERROR, "La feuille « {sheet} » dépasse le nombre maximal de lignes ({limit})."
    ),
    DiagnosticCode.SHEET_TOO_MANY_COLUMNS: CodeSpec(
        ERROR, "La feuille « {sheet} » dépasse le nombre maximal de colonnes ({limit})."
    ),
    DiagnosticCode.SHEET_NOT_FOUND: CodeSpec(
        ERROR,
        "Aucune feuille ne ressemble à une liste de prospects : en-têtes attendus introuvables.",
    ),
    DiagnosticCode.SHEET_SKIPPED: CodeSpec(
        INFO,
        "Feuille « {sheet} » ignorée : elle ne fait pas partie du modèle d'import des prospects.",
    ),
    DiagnosticCode.SHEET_MERGED_CELLS: CodeSpec(
        INFO,
        "Feuille « {sheet} » : {count} plage(s) de cellules fusionnées ; la valeur d'une fusion"
        " verticale est recopiée sur chacune de ses lignes.",
    ),
    DiagnosticCode.MAPPING_UNKNOWN_SHEET: CodeSpec(ERROR, "Feuille « {sheet} » introuvable."),
    DiagnosticCode.MAPPING_INVALID_HEADER_ROW: CodeSpec(
        ERROR, "La ligne {row} ne peut pas servir de ligne d'en-têtes (vide ou hors de la feuille)."
    ),
    DiagnosticCode.MAPPING_UNKNOWN_COLUMN: CodeSpec(ERROR, "Colonne {column} inexistante."),
    DiagnosticCode.MAPPING_DUPLICATE_FIELD: CodeSpec(
        ERROR, "Le champ « {label} » est associé à plusieurs colonnes."
    ),
    DiagnosticCode.COLUMN_UNMAPPED: CodeSpec(
        INFO,
        "Colonne {column} « {header} » non reconnue : ses valeurs sont conservées telles quelles.",
    ),
    DiagnosticCode.COLUMN_UNNAMED: CodeSpec(
        INFO,
        "Colonne {column} sans en-tête : ses valeurs éventuelles sont conservées telles quelles.",
    ),
    DiagnosticCode.COLUMN_DUPLICATE_HEADER: CodeSpec(
        WARNING,
        "Colonne {column} « {header} » en double : ses valeurs sont conservées telles quelles,"
        " à réaffecter si besoin.",
    ),
    DiagnosticCode.COLUMN_LEGACY_PRESERVED: CodeSpec(
        INFO,
        "Colonne {column} « {header} » conservée telle quelle : sa signification n'est pas"
        " confirmée.",
    ),
    DiagnosticCode.COLUMN_MISSING_KEY: CodeSpec(WARNING, "Colonne « {label} » absente du fichier."),
    DiagnosticCode.COLUMN_MISSING: CodeSpec(INFO, "Colonne « {label} » absente du fichier."),
    DiagnosticCode.CELL_MERGED_VALUE_COPIED: CodeSpec(
        INFO, "Valeur recopiée depuis une cellule fusionnée."
    ),
    DiagnosticCode.VALUE_TOO_LONG: CodeSpec(
        WARNING,
        "Valeur trop longue pour « {label} » ({limit} caractères au plus) : ignorée, {kept}.",
    ),
    DiagnosticCode.VALUE_ZERO_PLACEHOLDER: CodeSpec(
        INFO, f"Valeur « 0 » considérée comme vide ; {KEPT}."
    ),
    DiagnosticCode.PROSPECT_MISSING_NAME: CodeSpec(
        ERROR, "Ni nom ni prénom : le prospect ne peut pas être créé."
    ),
    DiagnosticCode.PROSPECT_PARTIAL_NAME: CodeSpec(WARNING, "Nom ou prénom manquant."),
    DiagnosticCode.COMPANY_MISSING: CodeSpec(
        WARNING, "Entreprise manquante : le prospect ne sera rattaché à aucune entreprise."
    ),
    DiagnosticCode.CIVILITY_INVALID: CodeSpec(
        WARNING, f"Civilité non reconnue (M. ou Mme attendu) : laissée vide, {KEPT}."
    ),
    DiagnosticCode.ROLE_SUGGESTED: CodeSpec(
        INFO, "Rôle proposé d'après la fonction : à confirmer."
    ),
    DiagnosticCode.ROLE_UNMATCHED: CodeSpec(
        WARNING,
        "Aucun rôle existant ne correspond à la fonction : à associer, créer ou laisser vide.",
    ),
    DiagnosticCode.ROLE_INACTIVE_MATCH: CodeSpec(
        WARNING, "La fonction correspond à un rôle désactivé : à réactiver ou à remplacer."
    ),
    DiagnosticCode.CATEGORY_SUGGESTED: CodeSpec(
        INFO, "Catégorie d'activité proposée : à confirmer."
    ),
    DiagnosticCode.CATEGORY_UNMATCHED: CodeSpec(
        WARNING, f"Catégorie d'activité inconnue : à associer, créer ou ignorer ; {KEPT}."
    ),
    DiagnosticCode.CATEGORY_INVALID: CodeSpec(
        WARNING, f"Valeur qui n'est pas une catégorie d'activité : ignorée, {KEPT}."
    ),
    DiagnosticCode.CATEGORY_INACTIVE_MATCH: CodeSpec(
        WARNING,
        "La valeur correspond à une catégorie d'activité désactivée : à réactiver ou remplacer.",
    ),
    DiagnosticCode.CATEGORY_SEGMENT_SUGGESTED: CodeSpec(
        INFO,
        "La valeur correspond à un segment commercial : proposé pour l'entreprise, à confirmer.",
    ),
    DiagnosticCode.REFERENT_MARKER: CodeSpec(
        WARNING, f"Marqueur historique (v, xxx, ?…) : {NOT_REFERENT}"
    ),
    DiagnosticCode.REFERENT_EMAIL_LIKE: CodeSpec(WARNING, f"Adresse e-mail : {NOT_REFERENT}"),
    DiagnosticCode.REFERENT_WEEK_MARKER: CodeSpec(WARNING, f"Semaine de contact : {NOT_REFERENT}"),
    DiagnosticCode.REFERENT_NOTE: CodeSpec(WARNING, f"Note libre : {NOT_REFERENT}"),
    DiagnosticCode.REFERENT_UNKNOWN: CodeSpec(
        WARNING,
        f"Référent interne inconnu : à créer dans les paramètres ou à laisser vide ; {KEPT}.",
    ),
    DiagnosticCode.REFERENT_PARTIAL_MATCH: CodeSpec(
        WARNING, "Référent reconnu partiellement (prénom, nom ou initiale seul) : à confirmer."
    ),
    DiagnosticCode.REFERENT_AMBIGUOUS: CodeSpec(
        WARNING, f"Plusieurs référents internes correspondent : à choisir ; {KEPT}."
    ),
    DiagnosticCode.REFERENT_INACTIVE: CodeSpec(
        WARNING, "Le référent correspond à une personne désactivée : à confirmer."
    ),
    DiagnosticCode.PLANNED_CONTACT_WEEK_WITHOUT_YEAR: CodeSpec(
        WARNING, f"Semaine de contact sans année : préciser l'année (jamais devinée) ; {KEPT}."
    ),
    DiagnosticCode.PLANNED_CONTACT_NOT_A_WEEK: CodeSpec(
        WARNING, f"Ni une semaine ni une date de contact : ignorée, {KEPT}."
    ),
    DiagnosticCode.PLANNED_CONTACT_INVALID_WEEK: CodeSpec(
        WARNING, f"Numéro de semaine impossible : ignoré, {KEPT}."
    ),
    DiagnosticCode.ACTIVITY_INACTIVE_SUGGESTED: CodeSpec(
        WARNING, "Statut d'activité « Inactif » suggéré (retraite, départ…) : à confirmer."
    ),
    DiagnosticCode.TRACKING_STAGE_CONFLICT: CodeSpec(
        WARNING,
        "Étapes de suivi contradictoires : l'étape la plus avancée est proposée, à vérifier.",
    ),
    DiagnosticCode.TRACKING_STAGE_UNRECOGNIZED: CodeSpec(
        WARNING, f"Valeur d'étape de suivi non reconnue : ignorée, {KEPT}."
    ),
    DiagnosticCode.EMAIL_INVALID: CodeSpec(WARNING, f"Adresse e-mail invalide : ignorée, {KEPT}."),
    DiagnosticCode.EMAIL_MULTIPLE_IN_CELL: CodeSpec(
        INFO, "Plusieurs adresses e-mail dans la cellule : la première valide devient principale."
    ),
    DiagnosticCode.PHONE_INVALID: CodeSpec(
        WARNING, f"Numéro de téléphone invalide : ignoré, {KEPT}."
    ),
    DiagnosticCode.PHONE_LEADING_ZERO_RESTORED: CodeSpec(
        WARNING, "Numéro saisi comme un nombre : le 0 initial a été restauré, à vérifier."
    ),
    DiagnosticCode.PHONE_UNRECOGNIZED_FORMAT: CodeSpec(
        WARNING, "Numéro sans indicatif ni format français : conservé tel quel, à vérifier."
    ),
    DiagnosticCode.PHONE_MULTIPLE_IN_CELL: CodeSpec(INFO, "Plusieurs numéros dans la cellule."),
    DiagnosticCode.ADDRESS_UNSTRUCTURED: CodeSpec(
        INFO, "Adresse sans code postal reconnu : conservée en texte libre."
    ),
    DiagnosticCode.ADDRESS_WITHOUT_COMPANY: CodeSpec(
        WARNING,
        f"Adresse sans entreprise : elle ne peut être rattachée à aucun établissement ; {KEPT}.",
    ),
    DiagnosticCode.COMPANY_FIELD_CONFLICT: CodeSpec(
        WARNING, "« {label} » a une autre valeur sur une autre ligne de la même entreprise."
    ),
    DiagnosticCode.COMPANY_VARIANT_IN_FILE: CodeSpec(
        INFO, "Même entreprise écrite autrement sur d'autres lignes du fichier."
    ),
    DiagnosticCode.COMPANY_EXISTING_MATCH: CodeSpec(
        INFO, "Entreprise déjà présente dans la base : rattachement proposé."
    ),
    DiagnosticCode.COMPANY_LIKELY_MATCH: CodeSpec(
        WARNING,
        "Entreprise proche d'une entreprise existante (nom ou domaine e-mail) : à vérifier.",
    ),
    DiagnosticCode.DUPLICATE_EMAIL_IN_FILE: CodeSpec(
        WARNING, "Adresse e-mail présente sur plusieurs lignes du fichier."
    ),
    DiagnosticCode.DUPLICATE_PERSON_IN_FILE: CodeSpec(
        WARNING, "Même personne (nom, prénom, entreprise) sur plusieurs lignes du fichier."
    ),
    DiagnosticCode.DUPLICATE_EMAIL_EXISTING: CodeSpec(
        WARNING, "Adresse e-mail déjà connue dans la base."
    ),
    DiagnosticCode.DUPLICATE_PERSON_EXISTING: CodeSpec(
        WARNING, "Personne déjà présente dans la base (mêmes nom, prénom et entreprise)."
    ),
    DiagnosticCode.DUPLICATE_PERSON_NAME_EXISTING: CodeSpec(
        INFO, "Homonyme dans la base (mêmes nom et prénom, autre entreprise)."
    ),
    DiagnosticCode.CONTACTABILITY_DO_NOT_CONTACT: CodeSpec(
        ERROR,
        "Correspond à un prospect « Ne pas contacter » : l'import ne peut ni le recréer ni le"
        " réactiver.",
    ),
    DiagnosticCode.CONTACTABILITY_POSSIBLE_DO_NOT_CONTACT: CodeSpec(
        WARNING, "Homonyme d'un prospect « Ne pas contacter » : à vérifier avant import."
    ),
}


class Diagnostic(BaseModel):
    model_config = ConfigDict(frozen=True)

    code: DiagnosticCode
    severity: Severity
    message: str
    row: int | None = None  # source row number (1-based, as in the spreadsheet)
    column: str | None = None  # column letter
    field: ImportField | None = None
    value: JsonScalar = None  # offending raw value, never part of the message


def diagnostic(
    code: DiagnosticCode,
    *,
    row: int | None = None,
    column: str | None = None,
    field: ImportField | None = None,
    value: JsonScalar = None,
    **params: object,
) -> Diagnostic:
    """A catalogue diagnostic; `params` fill the message placeholders (never cell values)."""
    return with_params(code, params, row=row, column=column, field=field, value=value)


def with_params(
    code: DiagnosticCode,
    params: Mapping[str, object],
    *,
    row: int | None = None,
    column: str | None = None,
    field: ImportField | None = None,
    value: JsonScalar = None,
) -> Diagnostic:
    spec = CATALOGUE[code]
    return Diagnostic(
        code=code,
        severity=spec.severity,
        message=spec.message.format_map({"kept": KEPT, "row": row, "column": column, **params}),
        row=row,
        column=column,
        field=field,
        value=value,
    )


class ImportRejectedError(InvalidInputError):
    """The file (or a mapping override) cannot be previewed at all. Carries a catalogue code."""

    def __init__(
        self,
        code: DiagnosticCode,
        *,
        row: int | None = None,
        column: str | None = None,
        **params: object,
    ) -> None:
        self.diagnostic = with_params(code, params, row=row, column=column)
        super().__init__(self.diagnostic.message)

    @property
    def code(self) -> DiagnosticCode:
        return self.diagnostic.code
