"""« Statut de la fiche » of a company and of a warehouse: verified / usable / incomplete.

Computed on read from the record itself (never stored, never typed in), like the prospect's
`Review` (`app.services.prospection.segments`). Each level is a list of requirements; the SQL
yields, per row, the codes of what is still missing, so a list can both filter on the status and
say what to complete.

**Company**
- *usable*: a name, a way to find it (website or e-mail domain), an identity (SIREN, or a site with
  postal code and city), a type (SME / large / institutional) and at least one person who is
  usable (a prospect with a verified e-mail, name, company and role, not set aside);
- *verified*: usable, plus SIREN, legal name, size, commercial segment and an activity category.

**Warehouse**
- *usable*: a name, a location (postal code and city), a prospecting category and a link to a
  building (`Establishment`) of a company that is itself usable;
- *verified*: usable, plus SIRET, a full address and a reachable interlocutor (name and e-mail,
  the owner's or a listed contact's).

Anything else is *incomplete*: not to be used as it stands.
"""

import uuid
from typing import Literal

from sqlalchemy import ColumnElement, Text, and_, case, cast, exists, func, null, or_, select
from sqlalchemy.dialects.postgresql import JSONPATH, array
from sqlalchemy.orm import aliased

from app.models import Company, Establishment, Prospect, Warehouse
from app.models.companies import company_activity_categories
from app.services.prospection.segments import (
    join_segment_sources,
    minimum_to_email,
    set_aside,
)

FileStatus = Literal["verified", "usable", "incomplete"]
FILE_STATUSES: tuple[FileStatus, ...] = ("verified", "usable", "incomplete")


def _filled(column: ColumnElement[str] | ColumnElement[str | None]) -> ColumnElement[bool]:
    return func.coalesce(func.btrim(column), "") != ""


def _missing(requirements: list[tuple[str, ColumnElement[bool]]]) -> ColumnElement[list[str]]:
    """The codes of the requirements that are not met, as a Postgres text array."""
    return func.array_remove(
        array(
            [case((~func.coalesce(met, False), code), else_=null()) for code, met in requirements],
            type_=Text,
        ),
        null(),
    )


def _usable_company_ids() -> ColumnElement[uuid.UUID]:
    """Companies with at least one person who can be e-mailed (the prospect `usable` minimum)."""
    return (
        join_segment_sources(select(Prospect.company_id))
        .where(Prospect.company_id.is_not(None), ~set_aside(), minimum_to_email())
        .correlate(None)
        .scalar_subquery()
    )


def company_missing() -> tuple[ColumnElement[list[str]], ColumnElement[list[str]]]:
    """`(missing to be usable, missing to be verified)` for `Company` rows."""
    building = aliased(Establishment)
    site = exists().where(
        building.company_id == Company.id,
        _filled(building.postal_code),
        _filled(building.city),
    )
    has_category = exists().where(company_activity_categories.c.company_id == Company.id)
    usable = _missing(
        [
            ("name", _filled(Company.display_name)),
            ("channel", or_(_filled(Company.website_url), _filled(Company.email_domain))),
            ("identity", or_(_filled(Company.siren), site)),
            ("kind", Company.company_kind.is_not(None)),
            ("person", Company.id.in_(_usable_company_ids())),
        ]
    )
    verified = _missing(
        [
            ("siren", _filled(Company.siren)),
            ("legal_name", _filled(Company.legal_name)),
            ("size", _filled(Company.size_label)),
            ("segment", Company.commercial_segment_id.is_not(None)),
            ("activity", has_category),
        ]
    )
    return usable, verified


def _is_empty(array_expression: ColumnElement[list[str]]) -> ColumnElement[bool]:
    return func.coalesce(func.cardinality(array_expression), 0) == 0


def company_status_condition(status: FileStatus) -> ColumnElement[bool]:
    usable, verified = company_missing()
    return status_condition(status, usable, verified)


def status_condition(
    status: FileStatus,
    usable: ColumnElement[list[str]],
    verified: ColumnElement[list[str]],
) -> ColumnElement[bool]:
    if status == "incomplete":
        return ~_is_empty(usable)
    if status == "usable":
        return and_(_is_empty(usable), ~_is_empty(verified))
    return and_(_is_empty(usable), _is_empty(verified))


def usable_establishment_ids() -> ColumnElement[uuid.UUID]:
    """Buildings that belong to a usable company."""
    usable, _ = company_missing()
    return (
        select(Establishment.id)
        .join(Company, Company.id == Establishment.company_id)
        .where(_is_empty(usable))
        .correlate(None)
        .scalar_subquery()
    )


def warehouse_missing() -> tuple[ColumnElement[list[str]], ColumnElement[list[str]]]:
    """`(missing to be usable, missing to be verified)` for `Warehouse` rows."""
    reachable_contact = func.jsonb_path_exists(
        Warehouse.contacts,
        cast('$[*] ? (@.email != null && @.email != "" && @.full_name != "")', JSONPATH),
    )
    usable = _missing(
        [
            ("name", _filled(Warehouse.name)),
            ("location", and_(_filled(Warehouse.postal_code), _filled(Warehouse.city))),
            ("category", Warehouse.prospecting_category.is_not(None)),
            (
                "company",
                and_(
                    Warehouse.establishment_id.is_not(None),
                    Warehouse.establishment_id.in_(usable_establishment_ids()),
                ),
            ),
        ]
    )
    verified = _missing(
        [
            ("siret", _filled(Warehouse.siret)),
            ("address", _filled(Warehouse.address)),
            (
                "interlocutor",
                or_(
                    and_(_filled(Warehouse.owner_name), _filled(Warehouse.owner_email)),
                    reachable_contact,
                ),
            ),
        ]
    )
    return usable, verified


def warehouse_status_condition(status: FileStatus) -> ColumnElement[bool]:
    usable, verified = warehouse_missing()
    return status_condition(status, usable, verified)


def status_of(usable_missing: list[str], verified_missing: list[str]) -> FileStatus:
    if usable_missing:
        return "incomplete"
    return "usable" if verified_missing else "verified"


def missing_of(usable_missing: list[str], verified_missing: list[str]) -> list[str]:
    """What keeps the file from its next level (empty when verified)."""
    return usable_missing or verified_missing
