"""SearchService (Task 17): the global search of the shell, read-only.

One query finds prospects (name, any of their e-mail addresses, a phone number), companies
(display or legal name, SIREN, e-mail domain, website) and establishments (SIRET, name, city).

- Names and cities compare folded (`search_key`: accents removed, lowercase), word by word: every
  word of the query must appear — anywhere when it has 3 characters or more, at the start of a word
  when it is shorter (`ma` finds Martin, not Thomas).
- E-mail addresses, domains and websites compare lowercase with the same length rule; SIREN, SIRET
  and phone numbers on digits (a phone query drops its national leading 0).
- Each result says how it matched — `exact` (the whole value), `prefix` (every word starts a word of
  the value, or the value starts with the query) or `contains` — and each group lists exact matches
  first, then prefixes, then the rest (by name), `GROUP_LIMIT` at most.

Every predicate is a `LIKE` over an expression covered by a trigram index of migration 0007, so a
search reads the matching rows only (ADR-0017). Like the Prospection query service (ADR-0014),
statements are built here, with bound parameters only: one per group. Definitions:
doc/features/global-search.md.
"""

import re
import uuid
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Literal

from sqlalchemy import (
    ColumnElement,
    Integer,
    Select,
    SQLColumnExpression,
    Subquery,
    Text,
    and_,
    case,
    cast,
    func,
    literal,
    literal_column,
    null,
    or_,
    select,
    union_all,
)
from sqlalchemy.orm import Session, aliased

from app.models import Company, Establishment, Prospect, Role
from app.models.enums import ActivityStatus, ContactabilityStatus
from app.models.prospects import Email, Phone
from app.services.errors import InvalidFieldError
from app.services.prospection.query import phone_needle

MIN_QUERY_LENGTH = 2
MAX_QUERY_LENGTH = 200
# Results per group; one more is read to tell whether the group has more.
GROUP_LIMIT = 5
# Shorter words only match the start of a word (a trigram index needs 3 characters to find a
# substring; 2 are enough at a word start).
SUBSTRING_MIN_LENGTH = 3
# Characters after which a word starts inside a value, besides its beginning.
WORD_SEPARATORS = (" ", "-", "'")
# A SIREN/SIRET query needs this many digits.
IDENTIFIER_MIN_DIGITS = 3
SIREN_LENGTH = 9
SIRET_LENGTH = 14
# Stored phone numbers are `+33…` for French numbers (import normalization, I-57).
FRANCE_PREFIX = "+33"

IDENTIFIER_QUERY = re.compile(r"[\d\s.\-]+")
URL_SCHEME = re.compile(r"^[a-z][a-z0-9+.\-]*://")
# Scheme and `www.` at the start, then everything from the first `/`, `?`, `#` or `:`: the host.
AROUND_HOST = r"^[a-z][a-z0-9+.\-]*://(www\.)?|[/?#:].*$"


class SearchType(StrEnum):
    PROSPECT = "prospect"
    COMPANY = "company"
    ESTABLISHMENT = "establishment"


class MatchKind(StrEnum):
    """How a result matched, best first (its index is the SQL rank)."""

    EXACT = "exact"
    PREFIX = "prefix"
    CONTAINS = "contains"


RANKS = list(MatchKind)


class MatchField(StrEnum):
    NAME = "name"
    LEGAL_NAME = "legal_name"
    EMAIL = "email"
    PHONE = "phone"
    SIREN = "siren"
    EMAIL_DOMAIN = "email_domain"
    WEBSITE = "website"
    SIRET = "siret"
    CITY = "city"


class Badge(StrEnum):
    DO_NOT_CONTACT = "do_not_contact"
    INACTIVE = "inactive"
    PRIMARY = "primary"


@dataclass(frozen=True, slots=True)
class Match:
    field: MatchField
    kind: MatchKind
    # The matched value when the label does not show it (an e-mail, a SIREN…); None for names.
    value: str | None


@dataclass(frozen=True, slots=True)
class Target:
    """What opening a result shows: a record editor, and the row in the Database Explorer."""

    editor: Literal["prospect", "company"]
    editor_id: uuid.UUID
    table: Literal["prospects", "companies", "establishments"]
    record_id: uuid.UUID


@dataclass(frozen=True, slots=True)
class ProspectHit:
    id: uuid.UUID
    label: str
    # Role · exact job title (the title once when it repeats the role).
    sublabel: str | None
    match: Match
    badges: list[Badge]
    target: Target
    company_id: uuid.UUID | None
    company_name: str | None
    type: Literal[SearchType.PROSPECT] = SearchType.PROSPECT


@dataclass(frozen=True, slots=True)
class CompanyHit:
    id: uuid.UUID
    label: str
    # Legal name, when it differs from the display name.
    sublabel: str | None
    match: Match
    badges: list[Badge]
    target: Target
    siren: str | None
    email_domain: str | None
    # City of the primary establishment.
    city: str | None
    prospect_count: int
    type: Literal[SearchType.COMPANY] = SearchType.COMPANY


@dataclass(frozen=True, slots=True)
class EstablishmentHit:
    id: uuid.UUID
    label: str
    # Address line, postal code and city.
    sublabel: str | None
    match: Match
    badges: list[Badge]
    target: Target
    company_id: uuid.UUID
    company_name: str
    siret: str | None
    type: Literal[SearchType.ESTABLISHMENT] = SearchType.ESTABLISHMENT


type SearchHit = ProspectHit | CompanyHit | EstablishmentHit


@dataclass(frozen=True, slots=True)
class SearchGroup:
    type: SearchType
    items: list[SearchHit]
    has_more: bool


@dataclass(frozen=True, slots=True)
class SearchResults:
    # The query as searched (spaces collapsed).
    query: str
    # Non-empty groups, the one with the best first match first (ties: prospects, companies,
    # establishments).
    groups: list[SearchGroup]


@dataclass(frozen=True, slots=True)
class Terms:
    """The query read for each kind of field."""

    text: str
    words: list[str]
    # Lowercase query when it is one word: e-mail addresses.
    token: str | None
    # Host-like form of that word (`https://www.exemple.fr/` or `jean@exemple.fr` → `exemple.fr`).
    host: str | None
    # Digits of a number-like query: SIREN, SIRET.
    digits: str | None
    # Digits a phone number must contain (`prospection.query.phone_needle`).
    phone: str | None


def read_terms(query: str) -> Terms:
    text = " ".join(query.split())
    if not MIN_QUERY_LENGTH <= len(text) <= MAX_QUERY_LENGTH:
        raise InvalidFieldError(
            "q",
            f"Search needs {MIN_QUERY_LENGTH} to {MAX_QUERY_LENGTH} characters.",
            reason="length",
        )
    token = text.lower() if " " not in text else None
    host = None
    if token is not None:
        host = URL_SCHEME.sub("", token.rsplit("@", 1)[-1]).removeprefix("www.").split("/")[0]
    digits = re.sub(r"\D", "", text) if IDENTIFIER_QUERY.fullmatch(text) else ""
    return Terms(
        text=text,
        words=text.split(" "),
        token=token,
        host=host or None,
        digits=digits if len(digits) >= IDENTIFIER_MIN_DIGITS else None,
        phone=phone_needle(text),
    )


# --- predicates --------------------------------------------------------------------------------


def _escape(value: str) -> str:
    """`value` matched literally by LIKE (escape character `\\`)."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _fold(value: SQLColumnExpression[Any] | str) -> ColumnElement[str]:
    """`search_key` (migration 0007): accents removed, lowercase."""
    return func.search_key(value, type_=Text)


def _like(value: SQLColumnExpression[Any], *parts: ColumnElement[str] | str) -> ColumnElement[bool]:
    pieces = [part if isinstance(part, ColumnElement) else literal(part, Text) for part in parts]
    pattern = pieces[0]
    for piece in pieces[1:]:
        pattern = pattern + piece
    return value.like(pattern, escape="\\")


def _starts_a_word(value: SQLColumnExpression[Any], needle: ColumnElement[str] | str) -> Any:
    return or_(
        _like(value, needle, "%"),
        *(_like(value, f"%{separator}", needle, "%") for separator in WORD_SEPARATORS),
    )


def _matches(value: SQLColumnExpression[Any], needle: ColumnElement[str] | str, size: int) -> Any:
    """`needle` anywhere in the text `value`, or only at a word start when it is shorter than 3."""
    if size >= SUBSTRING_MIN_LENGTH:
        return _like(value, "%", needle, "%")
    return _starts_a_word(value, needle)


def _raw_matches(value: SQLColumnExpression[Any], needle: str) -> ColumnElement[bool]:
    """`needle` anywhere in the address or domain `value`, or at its start when shorter than 3."""
    escaped = _escape(needle)
    if len(needle) >= SUBSTRING_MIN_LENGTH:
        return _like(value, "%", escaped, "%")
    return _like(value, escaped, "%")


def _value_rank(
    value: SQLColumnExpression[Any], exact: list[str], prefixes: list[str]
) -> ColumnElement[int]:
    return case(
        (value.in_(exact), 0),
        (or_(*(_like(value, _escape(prefix), "%") for prefix in prefixes)), 1),
        else_=2,
    )


# --- candidates --------------------------------------------------------------------------------


def _field(order: int) -> ColumnElement[int]:
    return literal_column(str(order), Integer)


def _folded_branch(
    row_id: SQLColumnExpression[uuid.UUID],
    key: ColumnElement[str],
    order: int,
    terms: Terms,
    *,
    value: SQLColumnExpression[Any] | None = None,
    exact: list[str] | None = None,
) -> Select[Any]:
    """Rows whose folded `key` holds every word: `(id, rank, field, value)`.

    `exact`: the texts whose key equals a whole match (default: the query)."""
    words = [(_fold(_escape(word)), len(word)) for word in terms.words]
    matched = (
        select(
            row_id.label("id"),
            key.label("key"),
            (cast(null(), Text) if value is None else value).label("value"),
        )
        .where(*(_matches(key, needle, size) for needle, size in words))
        # A barrier: the rank below reads the computed `key` column instead of folding again.
        .offset(0)
        .subquery()
    )
    rank = case(
        (matched.c.key.in_([_fold(text) for text in exact or [terms.text]]), 0),
        (and_(*(_starts_a_word(matched.c.key, needle) for needle, _ in words)), 1),
        else_=2,
    )
    return select(matched.c.id, rank.label("rank"), _field(order).label("field"), matched.c.value)


def _value_branch(
    row_id: SQLColumnExpression[uuid.UUID],
    compared: SQLColumnExpression[Any],
    order: int,
    where: ColumnElement[bool],
    rank: ColumnElement[int],
    value: SQLColumnExpression[Any] | None = None,
) -> Select[Any]:
    """Rows matching through a raw value (address, number, identifier): `(id, rank, field, value)`
    (`value` shown instead of `compared`, e.g. the website for its host)."""
    shown = compared if value is None else value
    return select(
        row_id.label("id"), rank.label("rank"), _field(order).label("field"), shown.label("value")
    ).where(where)


def _best(branches: list[Select[Any]]) -> Subquery:
    """The best match of each candidate row: lowest rank, then the field listed first."""
    candidates = union_all(*branches).subquery("candidates")
    return (
        select(candidates)
        .distinct(candidates.c.id)
        .order_by(candidates.c.id, candidates.c.rank, candidates.c.field)
        .subquery("best")
    )


def _match(fields: list[MatchField], row: Any) -> Match:
    return Match(field=fields[row.field], kind=RANKS[row.rank], value=row.value)


def _joined(separator: str, *parts: str | None) -> str | None:
    return separator.join(part for part in parts if part) or None


def _role_and_title(role: str | None, title: str | None) -> str | None:
    if role and title and role.casefold() == title.casefold():
        return role
    return _joined(" · ", role, title)


def _rotations(words: list[str]) -> list[str]:
    """`Dupont Jean` is exactly `Jean Dupont`: the query's words in any rotation."""
    return [" ".join(words[start:] + words[:start]) for start in range(len(words))]


# --- groups ------------------------------------------------------------------------------------

PROSPECT_FIELDS = [MatchField.NAME, MatchField.EMAIL, MatchField.PHONE]


def _prospect_branches(terms: Terms) -> list[Select[Any]]:
    name = func.person_search_key(Prospect.first_name, Prospect.last_name, type_=Text)
    branches = [_folded_branch(Prospect.id, name, 0, terms, exact=_rotations(terms.words))]
    if terms.token is not None:
        branches.append(
            _value_branch(
                Email.prospect_id,
                Email.address,
                1,
                _raw_matches(Email.address, terms.token),
                _value_rank(Email.address, [terms.token], [terms.token]),
            )
        )
    if terms.phone is not None:
        forms = [terms.phone, f"+{terms.phone}", f"{FRANCE_PREFIX}{terms.phone}"]
        branches.append(
            _value_branch(
                Phone.prospect_id,
                Phone.number,
                2,
                _like(Phone.number, "%", terms.phone, "%"),
                _value_rank(Phone.number, forms, forms),
            )
        )
    return branches


def _prospects(session: Session, terms: Terms) -> list[SearchHit]:
    best = _best(_prospect_branches(terms))
    rows = session.execute(
        select(
            Prospect.id,
            Prospect.first_name,
            Prospect.last_name,
            Prospect.exact_job_title,
            Prospect.activity_status,
            Prospect.contactability_status,
            Role.label.label("role"),
            Company.id.label("company_id"),
            Company.display_name.label("company_name"),
            best.c.rank,
            best.c.field,
            best.c.value,
        )
        .join(best, best.c.id == Prospect.id)
        .outerjoin(Company, Company.id == Prospect.company_id)
        .outerjoin(Role, Role.id == Prospect.role_id)
        .order_by(
            best.c.rank,
            _fold(Prospect.last_name).nulls_last(),
            _fold(Prospect.first_name).nulls_last(),
            Prospect.id,
        )
        .limit(GROUP_LIMIT + 1)
    ).all()
    hits: list[SearchHit] = []
    for row in rows:
        badges = []
        if row.contactability_status == ContactabilityStatus.DO_NOT_CONTACT:
            badges.append(Badge.DO_NOT_CONTACT)
        if row.activity_status == ActivityStatus.INACTIVE:
            badges.append(Badge.INACTIVE)
        hits.append(
            ProspectHit(
                id=row.id,
                label=_joined(" ", row.first_name, row.last_name) or "",
                sublabel=_role_and_title(row.role, row.exact_job_title),
                match=_match(PROSPECT_FIELDS, row),
                badges=badges,
                target=Target("prospect", row.id, "prospects", row.id),
                company_id=row.company_id,
                company_name=row.company_name,
            )
        )
    return hits


COMPANY_FIELDS = [
    MatchField.NAME,
    MatchField.LEGAL_NAME,
    MatchField.SIREN,
    MatchField.EMAIL_DOMAIN,
    MatchField.WEBSITE,
]


def _company_branches(terms: Terms) -> list[Select[Any]]:
    branches = [
        _folded_branch(Company.id, _fold(Company.display_name), 0, terms),
        _folded_branch(Company.id, _fold(Company.legal_name), 1, terms, value=Company.legal_name),
    ]
    if terms.digits is not None:
        where = _like(Company.siren, "%", terms.digits, "%")
        prefixes = [terms.digits]
        if len(terms.digits) == SIRET_LENGTH:
            # A SIRET also finds its company: its first nine digits are the SIREN.
            where = or_(where, Company.siren == terms.digits[:SIREN_LENGTH])
            prefixes.append(terms.digits[:SIREN_LENGTH])
        branches.append(
            _value_branch(
                Company.id,
                Company.siren,
                2,
                where,
                _value_rank(Company.siren, [terms.digits], prefixes),
            )
        )
    if terms.host is not None:
        branches.append(
            _value_branch(
                Company.id,
                Company.email_domain,
                3,
                _raw_matches(Company.email_domain, terms.host),
                _value_rank(Company.email_domain, [terms.host], [terms.host]),
            )
        )
    if terms.host is not None and len(terms.host) >= SUBSTRING_MIN_LENGTH:
        # Ranked on the host (`https://www.exemple.fr/contact` → `exemple.fr`), only for matches.
        website = func.lower(Company.website_url, type_=Text)
        host = func.regexp_replace(website, AROUND_HOST, "", "g", type_=Text)
        branches.append(
            _value_branch(
                Company.id,
                host,
                4,
                _raw_matches(website, terms.host),
                _value_rank(host, [terms.host], [terms.host]),
                value=Company.website_url,
            )
        )
    return branches


def _companies(session: Session, terms: Terms) -> list[SearchHit]:
    best = _best(_company_branches(terms))
    primary = aliased(Establishment, name="primary_establishment")
    prospect_count = (
        select(func.count())
        .where(Prospect.company_id == Company.id)
        .correlate(Company)
        .scalar_subquery()
    )
    rows = session.execute(
        select(
            Company.id,
            Company.display_name,
            Company.legal_name,
            Company.siren,
            Company.email_domain,
            primary.city,
            prospect_count.label("prospect_count"),
            best.c.rank,
            best.c.field,
            best.c.value,
        )
        .join(best, best.c.id == Company.id)
        .outerjoin(primary, and_(primary.company_id == Company.id, primary.is_primary))
        .order_by(best.c.rank, _fold(Company.display_name), Company.id)
        .limit(GROUP_LIMIT + 1)
    ).all()
    return [
        CompanyHit(
            id=row.id,
            label=row.display_name,
            sublabel=row.legal_name
            if row.legal_name and row.legal_name.casefold() != row.display_name.casefold()
            else None,
            match=_match(COMPANY_FIELDS, row),
            badges=[],
            target=Target("company", row.id, "companies", row.id),
            siren=row.siren,
            email_domain=row.email_domain,
            city=row.city,
            prospect_count=row.prospect_count,
        )
        for row in rows
    ]


ESTABLISHMENT_FIELDS = [MatchField.SIRET, MatchField.NAME, MatchField.CITY]


def _establishment_branches(terms: Terms) -> list[Select[Any]]:
    branches = [
        _folded_branch(Establishment.id, _fold(Establishment.name), 1, terms),
        _folded_branch(
            Establishment.id, _fold(Establishment.city), 2, terms, value=Establishment.city
        ),
    ]
    if terms.digits is not None:
        branches.append(
            _value_branch(
                Establishment.id,
                Establishment.siret,
                0,
                _like(Establishment.siret, "%", terms.digits, "%"),
                _value_rank(Establishment.siret, [terms.digits], [terms.digits]),
            )
        )
    return branches


def _establishments(session: Session, terms: Terms) -> list[SearchHit]:
    best = _best(_establishment_branches(terms))
    rows = session.execute(
        select(
            Establishment.id,
            Establishment.name,
            Establishment.kind,
            Establishment.siret,
            Establishment.address_line1,
            Establishment.postal_code,
            Establishment.city,
            Establishment.is_primary,
            Company.id.label("company_id"),
            Company.display_name.label("company_name"),
            best.c.rank,
            best.c.field,
            best.c.value,
        )
        .join(best, best.c.id == Establishment.id)
        .join(Company, Company.id == Establishment.company_id)
        .order_by(
            best.c.rank,
            _fold(Company.display_name),
            Establishment.is_primary.desc(),
            _fold(Establishment.name).nulls_last(),
            Establishment.id,
        )
        .limit(GROUP_LIMIT + 1)
    ).all()
    return [
        EstablishmentHit(
            id=row.id,
            label=row.name or row.kind or row.city or row.siret or "",
            sublabel=_joined(", ", row.address_line1, _joined(" ", row.postal_code, row.city)),
            match=_match(ESTABLISHMENT_FIELDS, row),
            badges=[Badge.PRIMARY] if row.is_primary else [],
            target=Target("company", row.company_id, "establishments", row.id),
            company_id=row.company_id,
            company_name=row.company_name,
            siret=row.siret,
        )
        for row in rows
    ]


# --- service -----------------------------------------------------------------------------------

GROUP_ORDER = [SearchType.PROSPECT, SearchType.COMPANY, SearchType.ESTABLISHMENT]


def search(session: Session, query: str) -> SearchResults:
    """Prospects, companies and establishments matching `query`, grouped and ranked."""
    terms = read_terms(query)
    found = {
        SearchType.PROSPECT: _prospects(session, terms),
        SearchType.COMPANY: _companies(session, terms),
        SearchType.ESTABLISHMENT: _establishments(session, terms),
    }
    groups = [
        SearchGroup(type=kind, items=hits[:GROUP_LIMIT], has_more=len(hits) > GROUP_LIMIT)
        for kind, hits in found.items()
        if hits
    ]
    groups.sort(
        key=lambda group: (RANKS.index(group.items[0].match.kind), GROUP_ORDER.index(group.type))
    )
    return SearchResults(query=terms.text, groups=groups)
