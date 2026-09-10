"""CompanyService: lightweight maintenance of companies and their establishments (Task 07).

A company is documentary context for prospects (employer, identifiers, classification, Circoe
context), not a CRM dossier. Rules (`doc/features/company-editor.md`):

- texts are trimmed (single-line ones with inner whitespace collapsed); blank means NULL; the
  display name is required;
- SIREN (9 digits) and SIRET (14 digits) ignore spaces and must pass their Luhn key (La Poste's
  SIRETs use their own rule); a stored identifier left unchanged is not re-checked, so imported
  values never block an unrelated edit; each is unique, and a conflict names the company holding it;
- the website gets `https://` when typed without a scheme; the e-mail domain is stored lowercase
  without `@`, scheme, path or `www.`, and a webmail domain is refused (it names no employer and
  would pollute company matching);
- one commercial segment, any number of activity categories (existing values: inline creation goes
  through the Settings API);
- establishments belong to the company and are saved with it as a full list (missing ones are
  removed); a non-empty list has exactly one primary establishment — when none is flagged, the
  first one is;
- deletion is refused while prospects reference the company; its establishments go with it.

Every mutation takes the server-side actor, annotates the audit event of each row it changes
(`company.*`, `establishment.*` with the company as subject) and flushes; the caller commits.
"""

import re
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, fields, replace
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models import CommercialSegment, Company, Establishment
from app.models.enums import ActivityStatus, Civility, ContactabilityStatus
from app.models.taxonomies import ActivityCategory
from app.repositories import companies as repository
from app.repositories import import_reference
from app.services import audit
from app.services.errors import (
    DuplicateValueError,
    ExistingValue,
    InUseError,
    InvalidFieldError,
    NotFoundError,
    is_foreign_key_violation,
    translated_violations,
    violated_constraint,
)
from app.services.imports.dedup import COMPANY_SIMILARITY
from app.services.imports.matching import company_key, similarity
from app.services.imports.models import MatchReason
from app.services.imports.rows import WEBMAIL_DOMAINS
from app.services.taxonomies import normalize_text

NAME_MAX_LENGTH = 255
SIZE_MAX_LENGTH = 100
POSTAL_CODE_MAX_LENGTH = 16
SHORT_MAX_LENGTH = 100  # establishment kind and country
CONTEXT_MAX_LENGTH = 10_000
DOMAIN_MAX_LENGTH = 253
LIST_MAX_LIMIT = 200
PROSPECTS_SHOWN = 100
SIMILAR_SHOWN = 5
# La Poste's establishments share this SIREN; their SIRETs are checked by digit sum instead.
LA_POSTE_SIREN = "356000000"

_LABEL = r"[^\W_](?:[\w-]{0,61}[^\W_])?"
HOSTNAME = re.compile(rf"(?:{_LABEL}\.)+{_LABEL}")
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://", re.IGNORECASE)


# --- values in and out -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EstablishmentInput:
    # None: a new establishment.
    id: uuid.UUID | None = None
    name: str | None = None
    siret: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    postal_code: str | None = None
    city: str | None = None
    country: str | None = None
    kind: str | None = None
    is_primary: bool = False


@dataclass(frozen=True, slots=True)
class CompanyInput:
    """The whole editable state of a company: an update replaces every field and the full list
    of establishments."""

    display_name: str
    legal_name: str | None = None
    siren: str | None = None
    website_url: str | None = None
    email_domain: str | None = None
    size_label: str | None = None
    commercial_segment_id: uuid.UUID | None = None
    activity_category_ids: Sequence[uuid.UUID] = ()
    project_done_with_circoe: str | None = None
    project_type: str | None = None
    circoe_references: str | None = None
    client_approach: str | None = None
    establishments: Sequence[EstablishmentInput] = ()


@dataclass(frozen=True, slots=True)
class TaxonomyRef:
    id: uuid.UUID
    label: str
    active: bool


@dataclass(frozen=True, slots=True)
class EstablishmentView:
    id: uuid.UUID
    name: str | None
    siret: str | None
    address_line1: str | None
    address_line2: str | None
    postal_code: str | None
    city: str | None
    country: str | None
    kind: str | None
    is_primary: bool


@dataclass(frozen=True, slots=True)
class ProspectSummary:
    """Enough to recognise a person in the company's list and open their record."""

    id: uuid.UUID
    civility: Civility | None
    first_name: str | None
    last_name: str | None
    role_label: str | None
    exact_job_title: str | None
    activity_status: ActivityStatus
    contactability_status: ContactabilityStatus


@dataclass(frozen=True, slots=True)
class CompanyDetail:
    id: uuid.UUID
    display_name: str
    legal_name: str | None
    siren: str | None
    website_url: str | None
    email_domain: str | None
    size_label: str | None
    commercial_segment: TaxonomyRef | None
    activity_categories: list[TaxonomyRef]
    project_done_with_circoe: str | None
    project_type: str | None
    circoe_references: str | None
    client_approach: str | None
    # Primary first, then by name.
    establishments: list[EstablishmentView]
    prospect_count: int
    # The first PROSPECTS_SHOWN, by last then first name.
    prospects: list[ProspectSummary]
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class CompanyListItem:
    id: uuid.UUID
    display_name: str
    legal_name: str | None
    siren: str | None
    email_domain: str | None
    commercial_segment_label: str | None
    # City of the primary establishment.
    city: str | None
    establishment_count: int
    prospect_count: int
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class CompanyPage:
    items: list[CompanyListItem]
    total: int


@dataclass(frozen=True, slots=True)
class SimilarCompany:
    id: uuid.UUID
    display_name: str
    legal_name: str | None
    email_domain: str | None
    reasons: list[MatchReason]


# --- identifiers and web values ----------------------------------------------------------------


def luhn_valid(digits: str) -> bool:
    total = 0
    for position, char in enumerate(reversed(digits)):
        digit = int(char) * (2 if position % 2 else 1)
        total += digit - 9 if digit > 9 else digit
    return total % 10 == 0


def siret_key_valid(siret: str) -> bool:
    if siret.startswith(LA_POSTE_SIREN):
        return sum(int(char) for char in siret) % 5 == 0
    return luhn_valid(siret)


def _identifier(field: str, value: str | None, length: int, label: str) -> str | None:
    """Digits of a SIREN/SIRET with spaces removed; None when blank."""
    digits = "".join((value or "").split())
    if not digits:
        return None
    if len(digits) != length or not digits.isascii() or not digits.isdigit():
        raise InvalidFieldError(field, f"{label} must have {length} digits.", "format")
    return digits


def normalize_siren(value: str | None, *, current: str | None = None) -> str | None:
    siren = _identifier("siren", value, 9, "SIREN")
    if siren is not None and siren != current and not luhn_valid(siren):
        raise InvalidFieldError("siren", "SIREN check digit is wrong.", "checksum")
    return siren


def normalize_siret(field: str, value: str | None, *, current: str | None = None) -> str | None:
    siret = _identifier(field, value, 14, "SIRET")
    if siret is not None and siret != current and not siret_key_valid(siret):
        raise InvalidFieldError(field, "SIRET check digit is wrong.", "checksum")
    return siret


def normalize_website(value: str | None) -> str | None:
    """`exemple.fr/contact` → `https://exemple.fr/contact`; scheme and host lowercase."""
    text = (value or "").strip()
    if not text:
        return None
    if not SCHEME.match(text):
        text = f"https://{text}"
    parts = urlsplit(text)
    host = parts.hostname or ""
    try:
        netloc = f"{host}:{parts.port}" if parts.port else host
    except ValueError:  # port not a number or out of range
        netloc = ""
    if (
        not netloc
        or parts.scheme.lower() not in {"http", "https"}
        or "@" in parts.netloc
        or not HOSTNAME.fullmatch(host)
        or any(char.isspace() for char in text)
    ):
        raise InvalidFieldError("website_url", "Invalid website address.", "format")
    path = "" if parts.path == "/" else parts.path
    return urlunsplit((parts.scheme.lower(), netloc, path, parts.query, parts.fragment))


def normalize_email_domain(value: str | None) -> str | None:
    """`@Exemple.fr`, `jean@exemple.fr`, `https://www.exemple.fr/` → `exemple.fr`."""
    text = (value or "").strip().lower().rpartition("@")[2]
    text = SCHEME.sub("", text).split("/")[0].removeprefix("www.").rstrip(".")
    if not text:
        return None
    if len(text) > DOMAIN_MAX_LENGTH or not HOSTNAME.fullmatch(text):
        raise InvalidFieldError("email_domain", "Invalid e-mail domain.", "format")
    if text in WEBMAIL_DOMAINS:
        raise InvalidFieldError("email_domain", "Webmail domains name no employer.", "webmail")
    return text


# --- validation ---------------------------------------------------------------------------------


def _line(field: str, value: str | None, max_length: int) -> str | None:
    text = normalize_text(value or "") or None
    if text is not None and len(text) > max_length:
        raise InvalidFieldError(field, f"{field} is longer than {max_length} characters.", "length")
    return text


def _paragraphs(field: str, value: str | None) -> str | None:
    text = (value or "").strip() or None
    if text is not None and len(text) > CONTEXT_MAX_LENGTH:
        raise InvalidFieldError(
            field, f"{field} is longer than {CONTEXT_MAX_LENGTH} characters.", "length"
        )
    return text


@dataclass(frozen=True, slots=True)
class _Cleaned:
    company: CompanyInput
    segment: CommercialSegment | None
    categories: list[ActivityCategory]


def _cleaned_establishment(
    index: int, data: EstablishmentInput, current: Establishment | None
) -> EstablishmentInput:
    path = f"establishments.{index}"
    return EstablishmentInput(
        id=data.id,
        name=_line(f"{path}.name", data.name, NAME_MAX_LENGTH),
        siret=normalize_siret(
            f"{path}.siret", data.siret, current=current.siret if current else None
        ),
        address_line1=_line(f"{path}.address_line1", data.address_line1, NAME_MAX_LENGTH),
        address_line2=_line(f"{path}.address_line2", data.address_line2, NAME_MAX_LENGTH),
        postal_code=_line(f"{path}.postal_code", data.postal_code, POSTAL_CODE_MAX_LENGTH),
        city=_line(f"{path}.city", data.city, NAME_MAX_LENGTH),
        country=_line(f"{path}.country", data.country, SHORT_MAX_LENGTH),
        kind=_line(f"{path}.kind", data.kind, SHORT_MAX_LENGTH),
        is_primary=data.is_primary,
    )


def _cleaned_establishments(
    data: Sequence[EstablishmentInput], company: Company | None
) -> list[EstablishmentInput]:
    owned = {row.id: row for row in company.establishments} if company else {}
    cleaned: list[EstablishmentInput] = []
    seen: set[uuid.UUID] = set()
    for index, item in enumerate(data):
        current = None
        if item.id is not None:
            current = owned.get(item.id)
            if current is None or item.id in seen:
                raise InvalidFieldError(
                    f"establishments.{index}.id", "Not an establishment of this company.", "unknown"
                )
            seen.add(item.id)
        cleaned.append(_cleaned_establishment(index, item, current))
    sirets = [item.siret for item in cleaned]
    for index, siret in enumerate(sirets):
        if siret is not None and siret in sirets[:index]:
            raise InvalidFieldError(
                f"establishments.{index}.siret", "SIRET given twice.", "repeated"
            )
    primaries = [index for index, item in enumerate(cleaned) if item.is_primary]
    if len(primaries) > 1:
        raise InvalidFieldError(
            f"establishments.{primaries[1]}.is_primary",
            "Only one primary establishment.",
            "multiple",
        )
    if cleaned and not primaries:
        cleaned[0] = replace(cleaned[0], is_primary=True)
    return cleaned


def _clean(session: Session, data: CompanyInput, company: Company | None) -> _Cleaned:
    display_name = _line("display_name", data.display_name, NAME_MAX_LENGTH)
    if display_name is None:
        raise InvalidFieldError("display_name", "display_name must not be blank.", "blank")
    cleaned = CompanyInput(
        display_name=display_name,
        legal_name=_line("legal_name", data.legal_name, NAME_MAX_LENGTH),
        siren=normalize_siren(data.siren, current=company.siren if company else None),
        website_url=normalize_website(data.website_url),
        email_domain=normalize_email_domain(data.email_domain),
        size_label=_line("size_label", data.size_label, SIZE_MAX_LENGTH),
        commercial_segment_id=data.commercial_segment_id,
        activity_category_ids=list(dict.fromkeys(data.activity_category_ids)),
        project_done_with_circoe=_paragraphs(
            "project_done_with_circoe", data.project_done_with_circoe
        ),
        project_type=_paragraphs("project_type", data.project_type),
        circoe_references=_paragraphs("circoe_references", data.circoe_references),
        client_approach=_paragraphs("client_approach", data.client_approach),
        establishments=_cleaned_establishments(data.establishments, company),
    )
    segment = None
    if cleaned.commercial_segment_id is not None:
        segment = repository.get_segment(session, cleaned.commercial_segment_id)
        if segment is None:
            raise InvalidFieldError(
                "commercial_segment_id", "Unknown commercial segment.", "unknown"
            )
    found = {row.id: row for row in repository.categories(session, cleaned.activity_category_ids)}
    if len(found) != len(cleaned.activity_category_ids):
        raise InvalidFieldError("activity_category_ids", "Unknown activity category.", "unknown")
    _refuse_taken_identifiers(session, cleaned, company)
    return _Cleaned(cleaned, segment, [found[id_] for id_ in cleaned.activity_category_ids])


def _existing(company: Company) -> ExistingValue:
    return ExistingValue(id=company.id, label=company.display_name, active=True)


def _siret_holder(session: Session, siret: str, company: Company | None) -> Company | None:
    own = [row.id for row in company.establishments] if company else []
    holder = repository.find_by_siret(session, siret, exclude_ids=own)
    return repository.get_company(session, holder.company_id) if holder else None


def _refuse_taken_identifiers(
    session: Session, data: CompanyInput, company: Company | None
) -> None:
    """SIREN/SIRET already held elsewhere → DuplicateValueError naming that company."""
    if data.siren is not None:
        same = repository.find_by_siren(
            session, data.siren, exclude_id=company.id if company else None
        )
        if same is not None:
            raise DuplicateValueError("siren", _existing(same))
    for index, item in enumerate(data.establishments):
        if item.siret is not None and (holder := _siret_holder(session, item.siret, company)):
            raise DuplicateValueError(f"establishments.{index}.siret", _existing(holder))


def _identifier_translator(
    session: Session, data: CompanyInput, company: Company | None
) -> Callable[[IntegrityError], DuplicateValueError | None]:
    """A SIREN/SIRET unique violation that raced past the pre-check → the same error."""

    def translate(error: IntegrityError) -> DuplicateValueError | None:
        match violated_constraint(error):
            case "uq_companies_siren" if data.siren:
                same = repository.find_by_siren(session, data.siren)
                return DuplicateValueError("siren", _existing(same) if same else None)
            case "uq_establishments_siret":
                for index, item in enumerate(data.establishments):
                    holder = repository.find_by_siret(session, item.siret) if item.siret else None
                    if holder is not None and (company is None or holder.company_id != company.id):
                        owner = repository.get_company(session, holder.company_id)
                        return DuplicateValueError(
                            f"establishments.{index}.siret", _existing(owner) if owner else None
                        )
        return None

    return translate


# --- reads ------------------------------------------------------------------------------------


def _ref(row: CommercialSegment | ActivityCategory) -> TaxonomyRef:
    return TaxonomyRef(id=row.id, label=row.label, active=row.active)


def _establishment_view(row: Establishment) -> EstablishmentView:
    return EstablishmentView(
        **{field.name: getattr(row, field.name) for field in fields(EstablishmentView)}
    )


def _company(session: Session, company_id: uuid.UUID) -> Company:
    company = repository.get_company(session, company_id)
    if company is None:
        raise NotFoundError(f"Company {company_id} not found.")
    return company


def get_company(session: Session, company_id: uuid.UUID) -> CompanyDetail:
    company = _company(session, company_id)
    segment = (
        repository.get_segment(session, company.commercial_segment_id)
        if company.commercial_segment_id
        else None
    )
    establishments = sorted(
        company.establishments,
        key=lambda row: (not row.is_primary, (row.name or "").casefold(), str(row.id)),
    )
    prospects = [
        ProspectSummary(
            id=prospect.id,
            civility=prospect.civility,
            first_name=prospect.first_name,
            last_name=prospect.last_name,
            role_label=role_label,
            exact_job_title=prospect.exact_job_title,
            activity_status=prospect.activity_status,
            contactability_status=prospect.contactability_status,
        )
        for prospect, role_label in repository.company_prospects(
            session, company.id, limit=PROSPECTS_SHOWN
        )
    ]
    return CompanyDetail(
        id=company.id,
        display_name=company.display_name,
        legal_name=company.legal_name,
        siren=company.siren,
        website_url=company.website_url,
        email_domain=company.email_domain,
        size_label=company.size_label,
        commercial_segment=_ref(segment) if segment else None,
        activity_categories=sorted(
            (_ref(row) for row in company.activity_categories), key=lambda ref: ref.label.casefold()
        ),
        project_done_with_circoe=company.project_done_with_circoe,
        project_type=company.project_type,
        circoe_references=company.circoe_references,
        client_approach=company.client_approach,
        establishments=[_establishment_view(row) for row in establishments],
        prospect_count=repository.count_prospects(session, company.id),
        prospects=prospects,
        created_at=company.created_at,
        updated_at=company.updated_at,
    )


def list_companies(
    session: Session, *, search: str | None = None, limit: int = 50, offset: int = 0
) -> CompanyPage:
    """Ordered by display name; `search` matches every word in the names, e-mail domain and
    website (case/accents ignored), or digits in a SIREN/SIRET."""
    rows, total = repository.list_companies(
        session,
        search=(search or "").strip() or None,
        limit=max(1, min(limit, LIST_MAX_LIMIT)),
        offset=max(0, offset),
    )
    items = [
        CompanyListItem(
            id=company.id,
            display_name=company.display_name,
            legal_name=company.legal_name,
            siren=company.siren,
            email_domain=company.email_domain,
            commercial_segment_label=segment_label,
            city=city,
            establishment_count=establishments,
            prospect_count=prospects,
            updated_at=company.updated_at,
        )
        for company, segment_label, prospects, establishments, city in rows
    ]
    return CompanyPage(items=items, total=total)


def find_similar(
    session: Session,
    *,
    name: str | None,
    email_domain: str | None = None,
    exclude_id: uuid.UUID | None = None,
) -> list[SimilarCompany]:
    """Existing companies the typed one may duplicate, for a warning before creating it: same
    name key (legal forms, accents, punctuation ignored — the import's company key), close
    spelling, or same e-mail domain. Suggestions only; nothing is refused."""
    key = company_key(name) if name and name.strip() else ""
    try:
        domain = normalize_email_domain(email_domain)
    except InvalidFieldError:
        domain = None
    found: list[tuple[float, SimilarCompany]] = []
    for id_, display_name, legal_name, company_domain in import_reference.company_rows(session):
        if id_ == exclude_id:
            continue
        keys = {company_key(text) for text in (display_name, legal_name) if text}
        reasons: list[MatchReason] = []
        score = 0.0
        if key and key in keys:
            reasons.append(MatchReason.SAME_COMPANY_NAME)
            score = 1.0
        elif key:
            closest = max((similarity(key, other) for other in keys), default=0.0)
            if closest >= COMPANY_SIMILARITY:
                reasons.append(MatchReason.SIMILAR_COMPANY_NAME)
                score = closest
        if domain and company_domain == domain:
            reasons.append(MatchReason.SAME_EMAIL_DOMAIN)
            score += 0.5
        if reasons:
            similar = SimilarCompany(id_, display_name, legal_name, company_domain, reasons)
            found.append((score, similar))
    found.sort(key=lambda item: (-item[0], item[1].display_name.casefold(), str(item[1].id)))
    return [similar for _, similar in found[:SIMILAR_SHOWN]]


# --- writes -----------------------------------------------------------------------------------

COMPANY_FIELDS = (
    "display_name",
    "legal_name",
    "siren",
    "website_url",
    "email_domain",
    "size_label",
    "commercial_segment_id",
    "project_done_with_circoe",
    "project_type",
    "circoe_references",
    "client_approach",
)
ESTABLISHMENT_FIELDS = tuple(
    field.name for field in fields(EstablishmentInput) if field.name != "id"
)


def _segment_labels(
    session: Session, company: Company, segment: CommercialSegment | None
) -> dict[str, tuple[str | None, str | None]]:
    """Readable before/after for a segment change in the audit event."""
    new_id = segment.id if segment else None
    if company.commercial_segment_id == new_id:
        return {}
    previous = (
        repository.get_segment(session, company.commercial_segment_id)
        if company.commercial_segment_id
        else None
    )
    return {
        "commercial_segment_id": (
            previous.label if previous else None,
            segment.label if segment else None,
        )
    }


def _apply_company(company: Company, cleaned: _Cleaned) -> None:
    # Categories first: loading them autoflushes, which would write the column changes apart.
    if {row.id for row in company.activity_categories} != {row.id for row in cleaned.categories}:
        company.activity_categories = cleaned.categories
    for name in COMPANY_FIELDS:
        setattr(company, name, getattr(cleaned.company, name))


def _differs(row: Establishment, data: EstablishmentInput) -> bool:
    return any(getattr(row, name) != getattr(data, name) for name in ESTABLISHMENT_FIELDS)


def _apply_establishment(row: Establishment, data: EstablishmentInput) -> None:
    for name in ESTABLISHMENT_FIELDS:
        setattr(row, name, getattr(data, name))


def _save_establishments(
    session: Session, actor: ActorContext, company: Company, cleaned: _Cleaned
) -> None:
    """Two flushes so the database's uniqueness never sees a transient clash: first removals and
    establishments losing the primary flag (freeing their SIRET and the primary slot), then the
    other changes and the new establishments. Each row changes in one flush: one audit event."""
    wanted = cleaned.company.establishments
    translate = _identifier_translator(session, cleaned.company, company)
    owned = {row.id: row for row in company.establishments}
    kept = {item.id for item in wanted if item.id is not None}
    first_pass = {
        item.id
        for item in wanted
        if item.id is not None and owned[item.id].is_primary and not item.is_primary
    }
    with translated_violations(session, translate):
        for row in [row for row in company.establishments if row.id not in kept]:
            audit.annotate(session, actor, row)
            company.establishments.remove(row)
            session.delete(row)
        for item in wanted:
            if item.id in first_pass:
                audit.annotate(session, actor, owned[item.id])
                _apply_establishment(owned[item.id], item)
    with translated_violations(session, translate):
        for item in wanted:
            if item.id is None:
                row = Establishment()
                _apply_establishment(row, item)
                audit.annotate(session, actor, row)
                company.establishments.append(row)
            elif item.id not in first_pass and _differs(owned[item.id], item):
                audit.annotate(session, actor, owned[item.id])
                _apply_establishment(owned[item.id], item)


def create_company(session: Session, actor: ActorContext, data: CompanyInput) -> CompanyDetail:
    """New company with its establishments (`company.created`, `establishment.created`)."""
    cleaned = _clean(session, data, None)
    company = Company()
    labels = _segment_labels(session, company, cleaned.segment)
    with translated_violations(session, _identifier_translator(session, cleaned.company, None)):
        _apply_company(company, cleaned)
        audit.annotate(session, actor, company, labels=labels)
        session.add(company)
    _save_establishments(session, actor, company, cleaned)
    return get_company(session, company.id)


def update_company(
    session: Session, actor: ActorContext, company_id: uuid.UUID, data: CompanyInput
) -> CompanyDetail:
    """Replace every field and the establishment list; only changed rows get an audit event."""
    company = _company(session, company_id)
    cleaned = _clean(session, data, company)
    labels = _segment_labels(session, company, cleaned.segment)
    audit.annotate(session, actor, company, labels=labels)
    with translated_violations(session, _identifier_translator(session, cleaned.company, company)):
        _apply_company(company, cleaned)
    _save_establishments(session, actor, company, cleaned)
    return get_company(session, company.id)


def delete_company(session: Session, actor: ActorContext, company_id: uuid.UUID) -> None:
    """Delete a company no prospect references (else `InUseError` with the count). Its
    establishments are deleted first, each with its own audit event."""
    company = _company(session, company_id)
    if (error := _in_use(session, company.id)) is not None:
        raise error

    def still_used(error: IntegrityError) -> InUseError | None:
        return _in_use(session, company.id) if is_foreign_key_violation(error) else None

    with translated_violations(session, still_used):
        for row in list(company.establishments):
            audit.annotate(session, actor, row)
            session.delete(row)
        audit.annotate(session, actor, company)
        session.delete(company)


def _in_use(session: Session, company_id: uuid.UUID) -> InUseError | None:
    used = repository.count_prospects(session, company_id)
    return InUseError({"prospects": used}) if used else None
