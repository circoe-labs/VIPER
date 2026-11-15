"""« Does it already exist? » for an agent that found a company, a person or a warehouse.

Compares like a careful person would, not like a database key: everything is folded (accents,
case, punctuation, legal forms, first/last name order), and a person is never judged on the name
alone — two people may share one. Each candidate says **why** it matches and **how each element
compares** (name, company, e-mail, phone…), so the agent can decide on what is left in doubt.

Verdict, from the best candidate's confidence: `exists` (≥ 0.9: the same record), `probable`
(≥ 0.7), `possible` (≥ 0.4: check before creating) or `none`. Nothing here writes.
"""

import re
import uuid
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models import Company, Establishment, Prospect, Warehouse
from app.models.prospects import Email, Phone
from app.services import companies
from app.services.errors import InvalidFieldError
from app.services.imports.dedup import COMPANY_SIMILARITY
from app.services.imports.matching import company_key, similarity
from app.services.imports.models import MatchReason
from app.services.imports.text import fold
from app.services.prospection.query import phone_needle

EXISTS = 0.9
PROBABLE = 0.7
POSSIBLE = 0.4
MAX_CANDIDATES = 10
CANDIDATE_POOL = 300
NAME_SIMILARITY = 0.85
MIN_PHONE_DIGITS = 6

ADVICE = {
    "exists": "Already in the base: update the existing record instead of creating a new one.",
    "probable": "Very likely the same record: open it and compare before creating anything.",
    "possible": (
        "Something looks alike but is not conclusive (a homonym, another site of the same "
        "group…): compare the `comparison` of each candidate, then decide."
    ),
    "none": "Nothing alike was found: it is safe to treat it as new.",
}


def _verdict(candidates: list[dict[str, Any]]) -> str:
    best = candidates[0]["confidence"] if candidates else 0.0
    if best >= EXISTS:
        return "exists"
    if best >= PROBABLE:
        return "probable"
    return "possible" if best >= POSSIBLE else "none"


def _answer(entity: str, checked: dict[str, Any], found: list[dict[str, Any]]) -> dict[str, Any]:
    found.sort(key=lambda item: (-item["confidence"], item["display_name"].casefold()))
    candidates = [item for item in found if item["confidence"] >= POSSIBLE][:MAX_CANDIDATES]
    verdict = _verdict(candidates)
    return {
        "entity": entity,
        "verdict": verdict,
        "advice": ADVICE[verdict],
        "checked": checked,
        "candidates": candidates,
    }


def _clean(values: Any) -> list[str]:
    return [str(value).strip() for value in values or () if value and str(value).strip()]


def _host(value: str | None) -> str | None:
    """`https://www.Exemple.fr/contact` → `exemple.fr`; a bare domain works too."""
    text = (value or "").strip().lower()
    if not text:
        return None
    host = urlsplit(text if "://" in text else f"//{text}").hostname or ""
    host = host.removeprefix("www.")
    return host if "." in host else None


def _domain(address: str) -> str | None:
    return address.rsplit("@", 1)[1].lower() if "@" in address else None


def _words(text: str) -> str:
    """Folded words in alphabetical order: `Dupont Jean` and `jean DUPONT` compare equal."""
    return " ".join(sorted(fold(text).split()))


# --- companies ----------------------------------------------------------------------------------


def check_company(
    session: Session,
    *,
    name: str | None = None,
    siren: str | None = None,
    siret: str | None = None,
    website: str | None = None,
    email_domain: str | None = None,
) -> dict[str, Any]:
    digits_siren = re.sub(r"\D", "", siren or "")
    digits_siret = re.sub(r"\D", "", siret or "")
    if len(digits_siret) == 14 and not digits_siren:
        digits_siren = digits_siret[:9]
    host = _host(website) or _host(email_domain)
    domain = (email_domain or "").strip().lower() or host
    if not (name or digits_siren or digits_siret or host):
        raise InvalidFieldError(
            "name", "Give a name, a SIREN/SIRET, a website or a domain.", "empty"
        )

    scored: dict[uuid.UUID, dict[str, Any]] = {}

    def note(company_id: uuid.UUID, score: float, reason: str, **facts: Any) -> None:
        entry = scored.setdefault(company_id, {"score": 0.0, "reasons": [], "facts": {}})
        entry["score"] = max(entry["score"], score)
        if reason not in entry["reasons"]:
            entry["reasons"].append(reason)
        entry["facts"].update(facts)

    if len(digits_siren) == 9:
        for owner in session.scalars(select(Company.id).where(Company.siren == digits_siren)):
            note(owner, 1.0, "same_siren")
    if len(digits_siret) == 14:
        for owner in session.scalars(
            select(Establishment.company_id).where(Establishment.siret == digits_siret)
        ):
            note(owner, 1.0, "same_siret")
    for similar in companies.find_similar(session, name=name, email_domain=domain):
        for reason in similar.reasons:
            match reason:
                case MatchReason.SAME_COMPANY_NAME:
                    note(similar.id, 0.85, "same_name")
                case MatchReason.SIMILAR_COMPANY_NAME:
                    note(similar.id, 0.6, "similar_name")
                case MatchReason.SAME_EMAIL_DOMAIN:
                    note(similar.id, 0.5, "same_email_domain")
                case _:
                    pass
    if host:
        pattern = f"%{host}%"
        for owner, website_url in session.execute(
            select(Company.id, Company.website_url).where(Company.website_url.ilike(pattern))
        ):
            if _host(website_url) == host:
                note(owner, 0.5, "same_website")

    rows = {
        row.id: row
        for row in session.scalars(select(Company).where(Company.id.in_(list(scored) or [None])))
    }
    found: list[dict[str, Any]] = []
    for company_id, entry in scored.items():
        company = rows[company_id]
        reasons = entry["reasons"]
        score = entry["score"]
        name_match = "same_name" in reasons
        shared_identity = any(code in reasons for code in ("same_email_domain", "same_website"))
        if name_match and shared_identity:
            score = max(score, 0.93)
        different_siren = bool(
            len(digits_siren) == 9 and company.siren and company.siren != digits_siren
        )
        if different_siren and score < 1.0:
            # Same name, other legal entity: a sister company, not the same one.
            score = min(score, 0.45)
            reasons.append("different_siren")
        found.append(
            {
                "id": str(company.id),
                "display_name": company.display_name,
                "legal_name": company.legal_name,
                "siren": company.siren,
                "email_domain": company.email_domain,
                "website_url": company.website_url,
                "confidence": round(min(score, 1.0), 2),
                "reasons": reasons,
                "comparison": {
                    "name": (
                        "same"
                        if name_match
                        else "similar"
                        if "similar_name" in reasons
                        else "different"
                    ),
                    "siren": (
                        "same"
                        if len(digits_siren) == 9 and company.siren == digits_siren
                        else "different"
                        if different_siren
                        else "unknown"
                    ),
                    "domain": (
                        "same"
                        if shared_identity
                        else "unknown"
                        if not (domain and company.email_domain)
                        else "different"
                    ),
                },
            }
        )
    checked = {"name": name, "siren": digits_siren or None, "domain": domain, "website_host": host}
    return _answer("company", checked, found)


# --- people -------------------------------------------------------------------------------------


def _company_comparison(
    session: Session,
    company_id: uuid.UUID | None,
    company_name: str | None,
    candidate: Prospect,
    candidate_company: Company | None,
) -> str:
    if candidate.company_id is None:
        return "candidate_has_no_company"
    if company_id is None and not (company_name or "").strip():
        return "unknown"
    if company_id is not None:
        return "same" if candidate.company_id == company_id else "different"
    wanted = company_key(company_name or "")
    keys = {
        company_key(text)
        for text in (
            (candidate_company.display_name, candidate_company.legal_name)
            if candidate_company
            else ()
        )
        if text
    }
    if wanted in keys:
        return "same"
    if any(similarity(wanted, key) >= COMPANY_SIMILARITY for key in keys):
        return "similar"
    return "different"


def check_prospect(
    session: Session,
    *,
    first_name: str | None = None,
    last_name: str | None = None,
    emails: list[str] | None = None,
    phones: list[str] | None = None,
    company_id: uuid.UUID | None = None,
    company_name: str | None = None,
    job_title: str | None = None,
) -> dict[str, Any]:
    addresses = [value.lower() for value in _clean(emails)]
    needles = [
        needle
        for number in _clean(phones)
        if (needle := phone_needle(number)) and len(needle) >= MIN_PHONE_DIGITS
    ]
    full_name = " ".join(part for part in (first_name, last_name) if part and part.strip())
    key = _words(full_name)
    if not key and not addresses and not needles:
        raise InvalidFieldError("last_name", "Give a name, an e-mail or a phone number.", "empty")
    if company_id is not None and session.get(Company, company_id) is None:
        raise InvalidFieldError("company_id", "Unknown company.", "unknown")

    clauses: list[ColumnElement[bool]] = []
    if addresses:
        clauses.append(
            Prospect.id.in_(select(Email.prospect_id).where(Email.address.in_(addresses)))
        )
    for needle in needles:
        clauses.append(
            Prospect.id.in_(
                select(Phone.prospect_id).where(Phone.number.contains(needle, autoescape=True))
            )
        )
    person_key = func.person_search_key(Prospect.first_name, Prospect.last_name)
    clauses.extend(person_key.op("LIKE")(f"%{token}%") for token in key.split() if len(token) > 2)
    candidates = session.scalars(
        select(Prospect)
        .options(selectinload(Prospect.emails), selectinload(Prospect.phones))
        .where(or_(*clauses))
        .limit(CANDIDATE_POOL)
    ).all()
    company_rows = {
        row.id: row
        for row in session.scalars(
            select(Company).where(
                Company.id.in_({c.company_id for c in candidates if c.company_id} or [None])
            )
        )
    }

    found: list[dict[str, Any]] = []
    for candidate in candidates:
        candidate_name = " ".join(
            part for part in (candidate.first_name, candidate.last_name) if part
        )
        other = _words(candidate_name)
        if not key or not other:
            name_match = "unknown"
        elif key == other:
            name_match = "same"
        elif similarity(key, other) >= NAME_SIMILARITY:
            name_match = "similar"
        else:
            name_match = "different"
        have = {email.address for email in candidate.emails}
        same_email = sorted(have & set(addresses))
        phone_digits = [re.sub(r"\D", "", phone.number) for phone in candidate.phones]
        same_phone = any(needle in digits for needle in needles for digits in phone_digits)
        shared_domain = bool({_domain(a) for a in addresses} & {_domain(a) for a in have} - {None})
        company = _company_comparison(
            session,
            company_id,
            company_name,
            candidate,
            company_rows.get(candidate.company_id) if candidate.company_id else None,
        )
        reasons: list[str] = []
        score = 0.0
        if same_email:
            score, reasons = 0.97, ["same_email"]
        if name_match == "same":
            reasons.append("same_name")
            score = max(
                score,
                {
                    "same": 0.95,
                    "similar": 0.85,
                    "unknown": 0.6,
                    "candidate_has_no_company": 0.6,
                    "different": 0.4,
                }[company],
            )
        elif name_match == "similar":
            reasons.append("similar_name")
            score = max(score, 0.75 if company == "same" else 0.3)
        if same_phone:
            reasons.append("same_phone")
            score = max(score + 0.2, 0.7)
        if name_match in ("same", "similar") and shared_domain and not same_email:
            reasons.append("same_email_domain")
            score += 0.2
        if score <= 0:
            continue
        found.append(
            {
                "id": str(candidate.id),
                "display_name": candidate_name or "(sans nom)",
                "company": (
                    {
                        "id": str(candidate.company_id),
                        "display_name": company_rows[candidate.company_id].display_name,
                    }
                    if candidate.company_id and candidate.company_id in company_rows
                    else None
                ),
                "exact_job_title": candidate.exact_job_title,
                "emails": sorted(have),
                "confidence": round(min(score, 0.99), 2),
                "reasons": reasons,
                "comparison": {
                    "name": name_match,
                    "company": company,
                    "email": "same" if same_email else "no_common_address",
                    "phone": "same" if same_phone else "no_common_number",
                    "email_domain": "same" if shared_domain else "different_or_unknown",
                    "job_title": (
                        "same"
                        if job_title
                        and candidate.exact_job_title
                        and fold(job_title) == fold(candidate.exact_job_title)
                        else "unknown"
                    ),
                },
            }
        )
    checked = {
        "name": full_name or None,
        "emails": addresses,
        "phone_digits": needles,
        "company_id": str(company_id) if company_id else None,
        "company_name": company_name,
    }
    return _answer("prospect", checked, found)


# --- warehouses ---------------------------------------------------------------------------------


def check_warehouse(
    session: Session,
    *,
    name: str | None = None,
    siret: str | None = None,
    postal_code: str | None = None,
    city: str | None = None,
    address: str | None = None,
) -> dict[str, Any]:
    digits = re.sub(r"\D", "", siret or "")
    key = company_key(name) if name and name.strip() else ""
    if not (key or len(digits) == 14):
        raise InvalidFieldError("name", "Give a name or a 14-digit SIRET.", "empty")
    postal = (postal_code or "").strip()
    town = fold(city or "")
    clauses: list[ColumnElement[bool]] = []
    if len(digits) == 14:
        clauses.append(Warehouse.siret == digits)
    for token in key.split():
        if len(token) > 2:
            clauses.append(func.search_key(Warehouse.name).op("LIKE")(f"%{token}%"))
    if postal:
        clauses.append(Warehouse.postal_code == postal)
    rows = session.scalars(select(Warehouse).where(or_(*clauses)).limit(CANDIDATE_POOL)).all()

    found: list[dict[str, Any]] = []
    for row in rows:
        other_key = company_key(row.name or "")
        same_siret = len(digits) == 14 and row.siret == digits
        if key and key == other_key:
            name_match = "same"
        elif key and other_key and similarity(key, other_key) >= NAME_SIMILARITY:
            name_match = "similar"
        else:
            name_match = "different"
        place = (
            "same"
            if (postal and row.postal_code == postal) or (town and fold(row.city or "") == town)
            else "unknown"
            if not (postal or town) or not (row.postal_code or row.city)
            else "different"
        )
        same_address = bool(address) and fold(address or "") == fold(row.address or "")
        reasons: list[str] = []
        score = 0.0
        if same_siret:
            score, reasons = 1.0, ["same_siret"]
        if name_match == "same":
            reasons.append("same_name")
            score = max(score, {"same": 0.95, "unknown": 0.6, "different": 0.45}[place])
        elif name_match == "similar":
            reasons.append("similar_name")
            score = max(score, 0.75 if place == "same" else 0.3)
        if same_address:
            reasons.append("same_address")
            score = max(score, 0.9 if name_match != "different" else 0.6)
        if score <= 0:
            continue
        found.append(
            {
                "id": str(row.id),
                "display_name": row.name,
                "siret": row.siret,
                "postal_code": row.postal_code,
                "city": row.city,
                "address": row.address,
                "confidence": round(min(score, 1.0), 2),
                "reasons": reasons,
                "comparison": {
                    "name": name_match,
                    "location": place,
                    "siret": "same" if same_siret else "unknown_or_different",
                    "address": "same" if same_address else "unknown_or_different",
                },
            }
        )
    checked = {"name": name, "siret": digits or None, "postal_code": postal or None, "city": city}
    return _answer("warehouse", checked, found)
