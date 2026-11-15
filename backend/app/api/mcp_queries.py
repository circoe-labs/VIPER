"""The query tools of `/mcp`: filter, cross and page the base, and check « does it exist? ».

`viper_find_companies`, `viper_find_warehouses` and `viper_find_prospects` take the same families
of criteria (free text, computed status, what is missing, filled / empty fields, links between
records, dates) and combine them with AND; `viper_review_queue` is the shortcut to what still has
to be verified; `viper_check_duplicate` compares a candidate with the base before anything is
created. All read-only, all behind `records.read`. Services: `app.services.mcp_queries`,
`app.services.mcp_duplicates`. Contract: `doc/architecture/mcp-server.md` §3.13.
"""

import uuid
from datetime import date
from typing import Any

from app.api.mcp_conversational import ReadContext, ReadTool
from app.api.routes import prospection as prospection_routes
from app.services import mcp_duplicates, mcp_queries
from app.services.errors import InvalidFieldError

CAPABILITY = "records.read"
_PAGE: dict[str, Any] = {
    "limit": {"type": "integer", "minimum": 1, "maximum": mcp_queries.LIST_MAX},
    "offset": {"type": "integer", "minimum": 0},
}
_SORT = {"type": "string", "enum": ["name", "created", "updated"]}
_DATES: dict[str, Any] = {
    "created_from": {"type": "string", "format": "date", "description": "Added on or after."},
    "created_to": {"type": "string", "format": "date", "description": "Added on or before."},
}
_UUIDS: dict[str, Any] = {"type": "array", "items": {"type": "string", "format": "uuid"}}
_STATE = {"type": "string", "enum": list(mcp_queries.STATES)}
_STATE_HELP = (
    "`status`: verified / usable / incomplete, or `to_verify` (= not verified yet: usable or "
    "incomplete). `missing`: only files still missing one of these requirement codes. `has` / "
    "`lacks`: fields that are filled / empty."
)


# --- argument parsing (the JSON Schema is advisory: a client may send anything) -------------------


def _text(args: dict[str, Any], name: str) -> str | None:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidFieldError(name, "Expected a string.", "format")
    return value


def _texts(args: dict[str, Any], name: str, limit: int = 50) -> list[str] | None:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise InvalidFieldError(name, "Expected a list of strings.", "format")
    return value[:limit]


def _uuid(value: Any, name: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError) as error:
        raise InvalidFieldError(name, "Expected a UUID.", "format") from error


def _uuids(args: dict[str, Any], name: str) -> list[uuid.UUID] | None:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, list):
        raise InvalidFieldError(name, "Expected a list of UUIDs.", "format")
    return [_uuid(item, name) for item in value[: mcp_queries.MAX_IDS]]


def _flag(args: dict[str, Any], name: str) -> bool | None:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, bool):
        raise InvalidFieldError(name, "Expected true or false.", "format")
    return value


def _count(args: dict[str, Any], name: str, default: int | None = None) -> int | None:
    value = args.get(name)
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise InvalidFieldError(name, "Expected a whole number, 0 or more.", "format")
    return value


def _day(args: dict[str, Any], name: str) -> date | None:
    value = _text(args, name)
    if value is None:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise InvalidFieldError(name, "Expected a date like 2026-11-15.", "format") from error


def _limit(args: dict[str, Any]) -> int:
    return _count(args, "limit", 50) or 50


def _offset(args: dict[str, Any]) -> int:
    return _count(args, "offset", 0) or 0


# --- handlers -----------------------------------------------------------------------------------


def _find_companies(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    return mcp_queries.find_companies(
        ctx.session,
        search=_text(args, "search"),
        ids=_uuids(args, "ids"),
        status=_text(args, "status"),
        missing=_texts(args, "missing"),
        company_kind=_text(args, "company_kind"),
        segment=_text(args, "segment"),
        has=_texts(args, "has"),
        lacks=_texts(args, "lacks"),
        postal_codes=_texts(args, "postal_codes"),
        cities=_texts(args, "cities"),
        min_prospects=_count(args, "min_prospects"),
        max_prospects=_count(args, "max_prospects"),
        sort=_text(args, "sort"),
        created_from=_day(args, "created_from"),
        created_to=_day(args, "created_to"),
        limit=_limit(args),
        offset=_offset(args),
    )


def _find_warehouses(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    return mcp_queries.find_warehouses(
        ctx.session,
        search=_text(args, "search"),
        ids=_uuids(args, "ids"),
        status=_text(args, "status"),
        missing=_texts(args, "missing"),
        category=_text(args, "category"),
        to_contact=_flag(args, "to_contact"),
        company_ids=_uuids(args, "company_ids"),
        company_names=_texts(args, "company_names", mcp_queries.MAX_NAMES),
        without_company=_flag(args, "without_company"),
        has=_texts(args, "has"),
        lacks=_texts(args, "lacks"),
        postal_codes=_texts(args, "postal_codes"),
        cities=_texts(args, "cities"),
        sort=_text(args, "sort"),
        created_from=_day(args, "created_from"),
        created_to=_day(args, "created_to"),
        limit=_limit(args),
        offset=_offset(args),
    )


def _get_warehouse(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    return mcp_queries.get_warehouse(ctx.session, _uuid(args.get("warehouse_id"), "warehouse_id"))


def _find_prospects(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    return mcp_queries.find_prospects(
        ctx.session,
        ctx.state.settings,
        prospection_routes.segment_context(ctx.state.settings),
        search=_text(args, "search"),
        status=_texts(args, "status"),
        segment=_text(args, "segment"),
        company_ids=_uuids(args, "company_ids"),
        company_names=_texts(args, "company_names", mcp_queries.MAX_NAMES),
        without_company=_flag(args, "without_company") or False,
        company_kind=_text(args, "company_kind"),
        reachable=_flag(args, "reachable") or False,
        include_ignored=_flag(args, "include_ignored") or False,
        sort=_text(args, "sort"),
        created_from=_day(args, "created_from"),
        created_to=_day(args, "created_to"),
        limit=_limit(args),
        offset=_offset(args),
    )


def _review_queue(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    entity = _text(args, "entity")
    context = prospection_routes.segment_context(ctx.state.settings)
    if entity is None:
        return {"counts": mcp_queries.verification_overview(ctx.session, context)}
    state = _text(args, "state") or "to_verify"
    limit, offset = _limit(args), _offset(args)
    sort = _text(args, "sort")
    match entity:
        case "company":
            answer = mcp_queries.find_companies(
                ctx.session,
                status=state,
                missing=_texts(args, "missing"),
                search=_text(args, "search"),
                sort=sort,
                limit=limit,
                offset=offset,
            )
        case "warehouse":
            answer = mcp_queries.find_warehouses(
                ctx.session,
                status=state,
                missing=_texts(args, "missing"),
                search=_text(args, "search"),
                sort=sort,
                limit=limit,
                offset=offset,
            )
        case "prospect":
            answer = mcp_queries.find_prospects(
                ctx.session,
                ctx.state.settings,
                context,
                status=[state],
                search=_text(args, "search"),
                sort=sort,
                limit=limit,
                offset=offset,
            )
        case _:
            raise InvalidFieldError("entity", "Expected company, warehouse or prospect.", "format")
    return {"entity": entity, "state": state, **answer}


def _check_duplicate(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    entity = _text(args, "entity")
    session = ctx.session
    match entity:
        case "company":
            return mcp_duplicates.check_company(
                session,
                name=_text(args, "name"),
                siren=_text(args, "siren"),
                siret=_text(args, "siret"),
                website=_text(args, "website"),
                email_domain=_text(args, "email_domain"),
            )
        case "prospect":
            company_id = args.get("company_id")
            return mcp_duplicates.check_prospect(
                session,
                first_name=_text(args, "first_name"),
                last_name=_text(args, "last_name"),
                emails=_texts(args, "emails"),
                phones=_texts(args, "phones"),
                company_id=_uuid(company_id, "company_id") if company_id else None,
                company_name=_text(args, "company_name"),
                job_title=_text(args, "job_title"),
            )
        case "warehouse":
            return mcp_duplicates.check_warehouse(
                session,
                name=_text(args, "name"),
                siret=_text(args, "siret"),
                postal_code=_text(args, "postal_code"),
                city=_text(args, "city"),
                address=_text(args, "address"),
            )
        case _:
            raise InvalidFieldError("entity", "Expected company, warehouse or prospect.", "format")


# --- catalogue ----------------------------------------------------------------------------------

_STRINGS = {"type": "array", "items": {"type": "string"}}

TOOLS: tuple[ReadTool, ...] = (
    ReadTool(
        name="viper_find_companies",
        capability=CAPABILITY,
        description=(
            "Search the companies with any combination of filters (AND), one page at a time. "
            "`search` (words in names, domain, website, SIREN), `ids`, `company_kind` (sme / "
            "large / institutional / unclassified), `segment` (label), `postal_codes` (prefixes "
            "such as 69 or 75008) and `cities` of their establishments, `min_prospects` / "
            "`max_prospects` (people held), creation dates. " + _STATE_HELP + " Company `has` / "
            "`lacks` fields: "
            + ", ".join(mcp_queries.COMPANY_FIELDS)
            + ". `missing` codes: "
            + ", ".join(mcp_queries.COMPANY_CODES)
            + ". Each row carries its `status`, what is "
            "`missing`, and its people / establishments / warehouses counts."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "search": {"type": "string", "maxLength": 200},
                "ids": _UUIDS,
                "status": _STATE,
                "missing": {"type": "array", "items": {"enum": list(mcp_queries.COMPANY_CODES)}},
                "company_kind": {
                    "type": "string",
                    "enum": ["sme", "large", "institutional", "unclassified"],
                },
                "segment": {"type": "string", "maxLength": 100},
                "has": {"type": "array", "items": {"enum": list(mcp_queries.COMPANY_FIELDS)}},
                "lacks": {"type": "array", "items": {"enum": list(mcp_queries.COMPANY_FIELDS)}},
                "postal_codes": _STRINGS,
                "cities": _STRINGS,
                "min_prospects": {"type": "integer", "minimum": 0},
                "max_prospects": {"type": "integer", "minimum": 0},
                **_DATES,
                "sort": _SORT,
                **_PAGE,
            },
            "additionalProperties": False,
        },
        handler=_find_companies,
    ),
    ReadTool(
        name="viper_find_warehouses",
        capability=CAPABILITY,
        description=(
            "Search the warehouses (entrepôts) with any combination of filters (AND). Owner: "
            "`company_ids` and/or `company_names` (any of them, so « those of A and B together »; "
            "the names are resolved and echoed in `resolved_companies`), or `without_company: "
            "true` for the warehouses linked to no company. Also `search`, `ids`, `category` "
            "(sme / other / unclassified), `to_contact`, `postal_codes` (prefixes), `cities`, "
            "creation dates. "
            + _STATE_HELP
            + " Warehouse `has` / `lacks` fields: "
            + ", ".join(mcp_queries.WAREHOUSE_FIELDS)
            + ' (e.g. `lacks: ["postal_code"]`). '
            "`missing` codes: " + ", ".join(mcp_queries.WAREHOUSE_CODES) + ". Each row carries "
            "its `status`, what is `missing`, its company and contacts."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "search": {"type": "string", "maxLength": 200},
                "ids": _UUIDS,
                "status": _STATE,
                "missing": {"type": "array", "items": {"enum": list(mcp_queries.WAREHOUSE_CODES)}},
                "category": {"type": "string", "enum": ["sme", "other", "unclassified"]},
                "to_contact": {"type": "boolean"},
                "company_ids": _UUIDS,
                "company_names": _STRINGS,
                "without_company": {"type": "boolean"},
                "has": {"type": "array", "items": {"enum": list(mcp_queries.WAREHOUSE_FIELDS)}},
                "lacks": {"type": "array", "items": {"enum": list(mcp_queries.WAREHOUSE_FIELDS)}},
                "postal_codes": _STRINGS,
                "cities": _STRINGS,
                **_DATES,
                "sort": _SORT,
                **_PAGE,
            },
            "additionalProperties": False,
        },
        handler=_find_warehouses,
    ),
    ReadTool(
        name="viper_get_warehouse",
        capability=CAPABILITY,
        description=(
            "Read one warehouse: address, owner, every listed contact, category, the company and "
            "building it belongs to, its `status` and what is still `missing`."
        ),
        input_schema={
            "type": "object",
            "properties": {"warehouse_id": {"type": "string", "format": "uuid"}},
            "required": ["warehouse_id"],
            "additionalProperties": False,
        },
        handler=_get_warehouse,
    ),
    ReadTool(
        name="viper_find_prospects",
        capability=CAPABILITY,
        description=(
            "Search the people with any combination of filters (AND): `search` (names, company, "
            "e-mail, phone), employer `company_ids` and/or `company_names` (any of them: « all "
            "the employees of A and B »; names are resolved and echoed in `resolved_companies`), "
            "`without_company: true` for people attached to no company, `company_kind`, "
            "`reachable`, creation dates. `status`: any of verified / usable / incomplete / "
            "ignored, or `to_verify` (usable or incomplete). `segment`: a named subset "
            "(never_verified, needs_recheck, active, unknown, inactive, do_not_contact, "
            "email_missing… see viper_get_prospection_metrics). The ignored people are hidden "
            "unless asked for (`status: [ignored]` or `include_ignored`)."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "search": {"type": "string", "maxLength": 200},
                "status": {
                    "type": "array",
                    "items": {"enum": ["verified", "usable", "incomplete", "ignored", "to_verify"]},
                },
                "segment": {"type": "string"},
                "company_ids": _UUIDS,
                "company_names": _STRINGS,
                "without_company": {"type": "boolean"},
                "company_kind": {
                    "type": "string",
                    "enum": ["sme", "large", "institutional", "unclassified"],
                },
                "reachable": {"type": "boolean"},
                "include_ignored": {"type": "boolean"},
                **_DATES,
                "sort": {
                    "type": "string",
                    "enum": ["name", "company", "verification", "updated", "created"],
                },
                **_PAGE,
            },
            "additionalProperties": False,
        },
        handler=_find_prospects,
    ),
    ReadTool(
        name="viper_review_queue",
        capability=CAPABILITY,
        description=(
            "What needs verifying — the first call of a verification agent. Without `entity`: "
            "how many companies, warehouses and people are verified / usable / incomplete / "
            "to_verify. With `entity` (company, warehouse or prospect): that list for `state` "
            "(default `to_verify`; or verified, usable, incomplete), each row with what is "
            "`missing` to reach the next level. `missing` narrows to one requirement code "
            "(companies and warehouses). For richer filters use the viper_find_* tools."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "entity": {"type": "string", "enum": list(mcp_queries.ENTITIES)},
                "state": _STATE,
                "missing": _STRINGS,
                "search": {"type": "string", "maxLength": 200},
                "sort": {"type": "string", "enum": ["name", "created", "updated"]},
                **_PAGE,
            },
            "additionalProperties": False,
        },
        handler=_review_queue,
    ),
    ReadTool(
        name="viper_check_duplicate",
        capability=CAPABILITY,
        description=(
            "Does it already exist? Compare something you found with the base BEFORE proposing "
            "it. `entity` company: name, siren/siret, website, email_domain. `entity` prospect: "
            "first_name, last_name, emails, phones, company_id or company_name, job_title — a "
            "person is never matched on the name alone (a homonym at another company is only "
            "`possible`). `entity` warehouse: name, siret, postal_code, city, address. "
            "Everything is compared folded (accents, case, legal forms, first/last name order). "
            "Answers a `verdict` (exists / probable / possible / none) and the closest "
            "`candidates`, each with its `reasons` and a field-by-field `comparison`."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "entity": {"type": "string", "enum": list(mcp_queries.ENTITIES)},
                "name": {"type": "string", "maxLength": 300},
                "first_name": {"type": "string", "maxLength": 100},
                "last_name": {"type": "string", "maxLength": 100},
                "emails": _STRINGS,
                "phones": _STRINGS,
                "company_id": {"type": "string", "format": "uuid"},
                "company_name": {"type": "string", "maxLength": 300},
                "job_title": {"type": "string", "maxLength": 255},
                "siren": {"type": "string", "maxLength": 20},
                "siret": {"type": "string", "maxLength": 20},
                "website": {"type": "string", "maxLength": 500},
                "email_domain": {"type": "string", "maxLength": 253},
                "postal_code": {"type": "string", "maxLength": 16},
                "city": {"type": "string", "maxLength": 255},
                "address": {"type": "string", "maxLength": 500},
            },
            "required": ["entity"],
            "additionalProperties": False,
        },
        handler=_check_duplicate,
    ),
)

BY_NAME: dict[str, ReadTool] = {tool.name: tool for tool in TOOLS}
