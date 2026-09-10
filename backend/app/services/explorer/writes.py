"""Applies a validated change set in the caller's transaction, all or nothing.

Writes go through the ORM, so the audit flush hook records one event per changed row with the
actor and source bound to the session (`database_explorer` for explorer routes). Where a domain
rule owns a column, the matching service is called instead of a generic assignment: a prospect's
`company_id` goes through `prospects.change_company` (I-13), contact tracking through
`save_contact_tracking` (status history). Link tables that are not audited as rows are written
through their audited owner's collection (`LINK_TABLES`).

Order: lock and check every targeted row (existence, version), check foreign-key targets and
domain blockers, then apply deletes, updates and inserts, each in its own savepoint. A change that
fails is retried after the others succeeded (e.g. unsetting a primary email before setting another
one), until a pass makes no progress. Any remaining error raises `ChangeSetRejected`; the caller's
transaction is then rolled back, so nothing is kept.
"""

import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Mapper, Session

from app.core.actor import ActorContext
from app.db.base import Base
from app.models import ActivityCategory, Company, ContactTracking, Prospect
from app.models.enums import ContactabilityStatus, ContactTrackingStatus
from app.services import contact_tracking, prospects
from app.services.audit_changes import to_json
from app.services.errors import DomainError
from app.services.explorer.changes import (
    ChangeError,
    ChangeSet,
    ChangeSetRejected,
    ErrorCode,
    RowDelete,
    RowInsert,
    RowUpdate,
)
from app.services.explorer.metadata import TableInfo

type Change = RowUpdate | RowInsert | RowDelete

DO_NOT_CONTACT_MESSAGE = "Ce prospect est en opposition : utilisez la fiche prospect."
DO_NOT_CONTACT_DELETE = (
    "Ce prospect est en opposition : utilisez la fiche prospect pour lever l’opposition avant"
    " de le supprimer."
)
TRACKING_FIELDS = (
    "status",
    "planned_contact_at",
    "referent_id",
    "response_received_at",
    "appointment_at",
)


@dataclass(frozen=True, slots=True)
class LinkTable:
    """A many-to-many table written through the collection of its audited owner."""

    owner: type[Any]
    owner_column: str
    collection: str
    target: type[Any]
    target_column: str


# `company_activity_categories` is not audited as rows (NOT_AUDITED_TABLES): its changes are
# recorded on the company as `activity_categories_ids` (`company.updated`).
LINK_TABLES: Mapping[str, LinkTable] = {
    "company_activity_categories": LinkTable(
        owner=Company,
        owner_column="company_id",
        collection="activity_categories",
        target=ActivityCategory,
        target_column="activity_category_id",
    )
}


@dataclass(frozen=True, slots=True)
class ApplyResult:
    updated: int
    inserted: int
    deleted: int
    # Primary keys of the inserted rows, in request order (JSON-safe values).
    inserted_keys: list[dict[str, Any]]


def apply_change_set(session: Session, actor: ActorContext, changes: ChangeSet) -> ApplyResult:
    """Apply every change or none; `ChangeSetRejected` carries all errors found."""
    writer = _Writer(session, actor, changes.table)
    rows = writer.locate([*changes.updates, *changes.deletes])
    writer.check_references([*changes.updates, *changes.inserts])
    writer.check_domain(changes, rows)
    if writer.errors:
        raise ChangeSetRejected(writer.errors)
    inserted = writer.apply([*changes.deletes, *changes.updates, *changes.inserts], rows)
    if writer.errors:
        raise ChangeSetRejected(writer.errors)
    return ApplyResult(
        updated=len(changes.updates),
        inserted=len(changes.inserts),
        deleted=len(changes.deletes),
        inserted_keys=[inserted[change.ref.index] for change in changes.inserts],
    )


class _Writer:
    def __init__(self, session: Session, actor: ActorContext, table: TableInfo) -> None:
        self.session = session
        self.actor = actor
        self.table = table
        self.link = LINK_TABLES.get(table.name)
        self.mapper: Mapper[Any] | None = None if self.link else _mapper(table.table)
        self.errors: list[ChangeError] = []

    def fail(
        self, change: Change, code: ErrorCode, message: str, column: str | None = None
    ) -> None:
        self.errors.append(ChangeError(change.ref, code, message, column))

    # --- checks ----------------------------------------------------------------------------

    def locate(self, changes: Iterable[RowUpdate | RowDelete]) -> dict[int, object]:
        """Lock each targeted row (keyed by `id()` of its change) and compare its version."""
        rows: dict[int, object] = {}
        for change in changes:
            row = self._load(change.key)
            if row is None:
                self.fail(change, ErrorCode.NOT_FOUND, "Cette ligne n’existe plus : actualisez.")
                continue
            version = self.table.version_column
            if version is not None and getattr(row, version.name) != change.version:
                self.fail(
                    change,
                    ErrorCode.CONFLICT,
                    "Ligne modifiée entre-temps : actualisez la table puis refaites la"
                    " modification.",
                )
                continue
            rows[id(change)] = row
        return rows

    def _load(self, key: Mapping[str, object]) -> object | None:
        if self.link is None:
            assert self.mapper is not None
            identity = tuple(key[column.name] for column in self.mapper.primary_key)
            return self.session.get(
                self.mapper.class_, identity, with_for_update=True, populate_existing=True
            )
        owner = self.session.get(self.link.owner, key[self.link.owner_column], with_for_update=True)
        target = self.session.get(self.link.target, key[self.link.target_column])
        linked = owner is not None and target in getattr(owner, self.link.collection)
        return (owner, target) if linked else None

    def check_references(self, changes: Iterable[RowUpdate | RowInsert]) -> None:
        """Every foreign-key value set by a change must name an existing row."""
        for change in changes:
            for name, value in change.values.items():
                column = self.table.column(name)
                if value is None or column is None or column.foreign_key is None:
                    continue
                target = Base.metadata.tables[column.foreign_key.table]
                exists = sa.select(sa.exists().where(target.c[column.foreign_key.column] == value))
                if not self.session.scalar(exists):
                    self.fail(
                        change,
                        ErrorCode.REFERENCE_NOT_FOUND,
                        f"Aucune ligne de {column.foreign_key.table} ne porte cet identifiant.",
                        name,
                    )

    def check_domain(self, changes: ChangeSet, rows: Mapping[int, object]) -> None:
        for delete in changes.deletes:
            row = rows.get(id(delete))
            if (
                isinstance(row, Prospect)
                and row.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
            ):
                self.fail(delete, ErrorCode.DO_NOT_CONTACT, DO_NOT_CONTACT_DELETE)
        for update in changes.updates:
            if isinstance(rows.get(id(update)), Prospect) and (
                "company_id" in update.values and update.values["company_id"] is None
            ):
                self.fail(
                    update,
                    ErrorCode.INVALID_VALUE,
                    "Un prospect ne peut pas être détaché de son entreprise ici.",
                    "company_id",
                )
        if self.table.name == ContactTracking.__tablename__:
            for insert in changes.inserts:
                prospect = self.session.get(Prospect, insert.values["prospect_id"])
                if prospect is not None and prospect.contact_tracking is not None:
                    self.fail(
                        insert,
                        ErrorCode.UNIQUE,
                        "Ce prospect a déjà un suivi de contact.",
                        "prospect_id",
                    )
        if self.link is not None:
            for insert in changes.inserts:
                if self._load(insert.values) is not None:
                    self.fail(insert, ErrorCode.UNIQUE, LINK_EXISTS)

    # --- application -----------------------------------------------------------------------

    def apply(self, changes: list[Change], rows: Mapping[int, object]) -> dict[int, dict[str, Any]]:
        """Apply in order, each change in a savepoint; retry failures while others succeed."""
        inserted: dict[int, dict[str, Any]] = {}
        remaining = changes
        failed: list[ChangeError] = []
        while remaining:
            failed, retry = [], []
            for change in remaining:
                error = self._attempt(change, rows, inserted)
                if error is not None:
                    failed.append(error)
                    retry.append(change)
            if len(retry) in (0, len(remaining)):
                break
            remaining = retry
        self.errors.extend(failed)
        return inserted

    def _attempt(
        self, change: Change, rows: Mapping[int, object], inserted: dict[int, dict[str, Any]]
    ) -> ChangeError | None:
        try:
            with self.session.begin_nested():
                if isinstance(change, RowInsert):
                    inserted[change.ref.index] = self._insert(change)
                elif isinstance(change, RowUpdate):
                    self._update(change, rows[id(change)])
                else:
                    self._delete(rows[id(change)])
                self.session.flush()
        except (IntegrityError, DataError) as error:
            return database_error(self.table, change, error)
        except DomainError as error:
            return ChangeError(change.ref, ErrorCode.REJECTED, str(error))
        return None

    def _update(self, change: RowUpdate, row: object) -> None:
        values = dict(change.values)
        if isinstance(row, ContactTracking):
            fields: dict[str, Any] = {name: getattr(row, name) for name in TRACKING_FIELDS}
            data = contact_tracking.ContactTrackingInput(**(fields | values))
            contact_tracking.save_contact_tracking(self.session, self.actor, row.prospect_id, data)
            return
        if isinstance(row, Prospect) and "company_id" in values:
            company_id = values.pop("company_id")
            assert isinstance(company_id, uuid.UUID)
            prospects.change_company(self.session, self.actor, row.id, company_id)
        self._assign(row, values)

    def _insert(self, change: RowInsert) -> dict[str, Any]:
        values = change.values
        if self.link is not None:
            owner, target = (
                self.session.get_one(self.link.owner, values[self.link.owner_column]),
                self.session.get_one(self.link.target, values[self.link.target_column]),
            )
            getattr(owner, self.link.collection).append(target)
            return {name: to_json(value) for name, value in values.items()}
        if self.table.name == ContactTracking.__tablename__:
            fields: dict[str, Any] = {"status": ContactTrackingStatus.TO_CONTACT}
            fields |= {name: values[name] for name in TRACKING_FIELDS if name in values}
            data = contact_tracking.ContactTrackingInput(**fields)
            prospect_id = values["prospect_id"]
            assert isinstance(prospect_id, uuid.UUID)
            row: object = contact_tracking.save_contact_tracking(
                self.session, self.actor, prospect_id, data
            )
        else:
            assert self.mapper is not None
            row = self.mapper.class_()
            self._assign(row, values)
            self.session.add(row)
        self.session.flush()
        assert self.mapper is not None
        return {
            column.name: to_json(getattr(row, self.mapper.get_property_by_column(column).key))
            for column in self.mapper.primary_key
        }

    def _delete(self, row: object) -> None:
        if self.link is not None:
            assert isinstance(row, tuple)
            owner, target = row
            getattr(owner, self.link.collection).remove(target)
        else:
            self.session.delete(row)

    def _assign(self, row: object, values: Mapping[str, object]) -> None:
        assert self.mapper is not None
        for name, value in values.items():
            key = self.mapper.get_property_by_column(self.table.table.c[name]).key
            setattr(row, key, value)


def _mapper(table: sa.Table) -> Mapper[Any]:
    for mapper in Base.registry.mappers:
        if mapper.local_table is table:
            return mapper
    raise LookupError(f"{table.name} has no ORM model and no link-table writer.")


# --- database errors in French ---------------------------------------------------------------

LINK_EXISTS = "Cette entreprise porte déjà cette catégorie d’activité."
_SLUG = "Clé invalide : minuscules, chiffres et tirets (ex. responsable-transport)."
_EMAIL = "Adresse e-mail invalide : minuscules, sans espace, au format nom@domaine."


def _taxonomy_messages(table: str) -> dict[str, tuple[str | None, str]]:
    return {
        f"uq_{table}_slug": ("slug", "Cette clé (slug) est déjà utilisée."),
        f"uq_{table}_lower_label": (
            "label",
            "Ce libellé existe déjà (majuscules ignorées), peut-être désactivé : réactivez-le"
            " plutôt.",
        ),
        f"ck_{table}_slug_format": ("slug", _SLUG),
        f"ck_{table}_label_not_blank": ("label", "Le libellé ne peut pas être vide."),
    }


# Constraint name → (column shown in the grid, message). Enum CHECKs (`ck_<table>_<column>`) and
# foreign keys are described generically; a test requires every other constraint of a writable
# table to be listed here.
CONSTRAINT_MESSAGES: Mapping[str, tuple[str | None, str]] = {
    **_taxonomy_messages("roles"),
    **_taxonomy_messages("commercial_segments"),
    **_taxonomy_messages("activity_categories"),
    "ck_internal_referents_name_not_blank": (None, "Le prénom et le nom sont obligatoires."),
    "ck_internal_referents_email_format": ("email", _EMAIL),
    "uq_companies_siren": ("siren", "Ce SIREN est déjà utilisé par une autre entreprise."),
    "ck_companies_siren_format": ("siren", "Le SIREN compte exactement 9 chiffres."),
    "ck_companies_display_name_not_blank": ("display_name", "Le nom ne peut pas être vide."),
    "ck_companies_email_domain_format": (
        "email_domain",
        "Domaine invalide : minuscules, au format exemple.fr, sans @.",
    ),
    "pk_company_activity_categories": (None, LINK_EXISTS),
    "uq_establishments_siret": ("siret", "Ce SIRET est déjà utilisé par un autre établissement."),
    "ck_establishments_siret_format": ("siret", "Le SIRET compte exactement 14 chiffres."),
    "uq_establishments_company_id_primary": (
        "is_primary",
        "Cette entreprise a déjà un établissement principal.",
    ),
    "ck_prospects_has_name": (None, "Un prospect doit garder au moins un prénom ou un nom."),
    "ck_prospects_do_not_contact_consistency": ("contactability_status", DO_NOT_CONTACT_MESSAGE),
    "uq_contact_tracking_prospect_id": ("prospect_id", "Ce prospect a déjà un suivi de contact."),
    "uq_emails_prospect_id_address": ("address", "Ce prospect a déjà cette adresse e-mail."),
    "uq_emails_prospect_id_primary": (
        "is_primary",
        "Un e-mail principal actif existe déjà pour ce prospect.",
    ),
    "ck_emails_address_format": ("address", _EMAIL),
    "ck_emails_primary_is_active": ("is_primary", "Un e-mail principal doit rester actif."),
    "uq_phones_prospect_id_number": ("number", "Ce prospect a déjà ce numéro."),
    "uq_phones_prospect_id_primary": (
        "is_primary",
        "Un téléphone principal actif existe déjà pour ce prospect.",
    ),
    "ck_phones_number_format": (
        "number",
        "Numéro invalide : 4 à 20 chiffres, éventuellement précédés de +, sans espace.",
    ),
    "ck_phones_primary_is_active": ("is_primary", "Un téléphone principal doit rester actif."),
}


def database_error(
    table: TableInfo, change: Change, error: IntegrityError | DataError
) -> ChangeError:
    """A database refusal as a French, per-change error pointing at a column when possible."""
    origin = error.orig
    diag = getattr(origin, "diag", None)
    sqlstate = getattr(origin, "sqlstate", None)
    constraint = getattr(diag, "constraint_name", None)
    column: str | None = getattr(diag, "column_name", None)

    def result(code: ErrorCode, message: str, at: str | None = column) -> ChangeError:
        return ChangeError(change.ref, code, message, at)

    if sqlstate == "23001" and "do_not_contact" in str(origin):
        deleting = isinstance(change, RowDelete)
        return result(
            ErrorCode.DO_NOT_CONTACT, DO_NOT_CONTACT_DELETE if deleting else DO_NOT_CONTACT_MESSAGE
        )
    if constraint is not None and constraint in CONSTRAINT_MESSAGES:
        at, message = CONSTRAINT_MESSAGES[constraint]
        code = ErrorCode.UNIQUE if sqlstate == "23505" else ErrorCode.CHECK
        return result(code, message, at)
    if sqlstate == "23503":
        return _foreign_key_error(table, change, constraint)
    if sqlstate == "23502":
        return result(ErrorCode.REQUIRED, "Valeur obligatoire : la colonne refuse NULL.")
    if sqlstate == "23505":
        return result(ErrorCode.UNIQUE, f"Cette valeur existe déjà (contrainte {constraint}).")
    if sqlstate == "23514" and constraint:
        at = constraint.removeprefix(f"ck_{table.name}_")
        if table.column(at) is not None:
            return result(ErrorCode.CHECK, "Valeur non autorisée.", at)
        return result(ErrorCode.CHECK, f"Valeur refusée par la contrainte {constraint}.")
    return result(ErrorCode.REJECTED, "Valeur refusée par la base de données.")


def _foreign_key_error(table: TableInfo, change: Change, constraint: str | None) -> ChangeError:
    for other in Base.metadata.tables.values():
        for foreign_key in other.foreign_keys:
            if foreign_key.constraint is None or foreign_key.constraint.name != constraint:
                continue
            if isinstance(change, RowDelete):
                return ChangeError(
                    change.ref,
                    ErrorCode.FOREIGN_KEY,
                    f"Suppression bloquée : des lignes de {other.name} la référencent encore.",
                )
            return ChangeError(
                change.ref,
                ErrorCode.REFERENCE_NOT_FOUND,
                f"La ligne référencée n’existe pas dans {foreign_key.column.table.name}.",
                foreign_key.parent.name,
            )
    return ChangeError(change.ref, ErrorCode.FOREIGN_KEY, "Référence refusée par la base.")
