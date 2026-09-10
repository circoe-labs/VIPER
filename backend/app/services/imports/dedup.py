"""Duplicate candidates (in the file and against the database snapshot) and contactability.

Candidates only, never decisions. People: same normalized email (confidence 1.0), same folded
first + last name and company key (0.9), same name elsewhere (0.5, existing prospects only).
Companies: same company key (0.9, 1.0 when the folded display name is identical), same
non-webmail email domain (0.7), close spelling of the key (0.6). A row matching a `do_not_contact`
prospect by email or by name + company is blocked (error): Task 09 may only skip it or attach it to
that prospect, which stays `do_not_contact`.
"""

import uuid
from collections import defaultdict
from collections.abc import Iterable, Sequence

from app.models.enums import ContactabilityStatus
from app.services.imports.diagnostics import DiagnosticCode
from app.services.imports.fields import SPECS, ImportField
from app.services.imports.matching import company_key, similarity
from app.services.imports.models import MatchReason
from app.services.imports.reference import ImportReferenceData, ReferenceCompany
from app.services.imports.rows import COMPANY_TEXT_FIELDS, REASON_CONFIDENCE, RowDraft
from app.services.imports.text import fold

COMPANY_SIMILARITY = 0.85
PERSON_REASONS = frozenset({MatchReason.SAME_EMAIL, MatchReason.SAME_PERSON})


def person_key(draft: RowDraft) -> tuple[str, str] | None:
    first = fold(draft.prospect.first_name or "")
    last = fold(draft.prospect.last_name or "")
    return (first, last) if first and last else None


def annotate_duplicates(drafts: Sequence[RowDraft], reference: ImportReferenceData) -> int:
    """Add candidates and diagnostics to `drafts`; returns the number of in-file email groups."""
    groups = in_file_emails(drafts)
    in_file_people(drafts)
    in_file_companies(drafts)
    existing_people(drafts, reference)
    existing_companies(drafts, reference.companies)
    return groups


def link_rows(rows: Sequence[RowDraft], reason: MatchReason) -> None:
    for draft in rows:
        for other in rows:
            if other is not draft:
                draft.file_matches.setdefault(other.number, set()).add(reason)


def in_file_emails(drafts: Sequence[RowDraft]) -> int:
    by_email: dict[str, list[RowDraft]] = defaultdict(list)
    for draft in drafts:
        for email in draft.emails:
            by_email[email.address].append(draft)
    groups = [rows for rows in by_email.values() if len(rows) > 1]
    flagged: set[int] = set()
    for rows in groups:
        link_rows(rows, MatchReason.SAME_EMAIL)
        for draft in rows:
            if draft.number not in flagged:
                flagged.add(draft.number)
                draft.flag(DiagnosticCode.DUPLICATE_EMAIL_IN_FILE, ImportField.EMAIL)
    return len(groups)


def in_file_people(drafts: Sequence[RowDraft]) -> None:
    by_person: dict[tuple[str, str, str], list[RowDraft]] = defaultdict(list)
    for draft in drafts:
        if (key := person_key(draft)) and draft.company is not None:
            by_person[(*key, draft.company.match_key)].append(draft)
    for rows in by_person.values():
        if len(rows) > 1:
            link_rows(rows, MatchReason.SAME_PERSON)
            for draft in rows:
                draft.flag(DiagnosticCode.DUPLICATE_PERSON_IN_FILE)


def in_file_companies(drafts: Sequence[RowDraft]) -> None:
    """Rows of one company key: spelling variants (info) and differing company-level values."""
    by_company: dict[str, list[RowDraft]] = defaultdict(list)
    for draft in drafts:
        if draft.company is not None:
            by_company[draft.company.match_key].append(draft)
    for rows in by_company.values():
        companies = [draft.company for draft in rows if draft.company is not None]
        if len({company.display_name for company in companies}) > 1:
            for draft in rows:
                draft.flag(DiagnosticCode.COMPANY_VARIANT_IN_FILE, ImportField.COMPANY_NAME)
        for field in COMPANY_TEXT_FIELDS:
            values = {getattr(company, field.value) for company in companies} - {None}
            if len(values) < 2:
                continue
            for draft in rows:
                if draft.company is not None and getattr(draft.company, field.value) is not None:
                    draft.flag(
                        DiagnosticCode.COMPANY_FIELD_CONFLICT, field, label=SPECS[field].label
                    )


def existing_people(drafts: Sequence[RowDraft], reference: ImportReferenceData) -> None:
    company_keys = {
        company.id: company_key(company.display_name) for company in reference.companies
    }
    by_email: dict[str, list[uuid.UUID]] = defaultdict(list)
    by_name: dict[tuple[str, str], list[uuid.UUID]] = defaultdict(list)
    prospects = {prospect.id: prospect for prospect in reference.prospects}
    for prospect in reference.prospects:
        for address in prospect.emails:
            by_email[address].append(prospect.id)
        first, last = fold(prospect.first_name or ""), fold(prospect.last_name or "")
        if first and last:
            by_name[(first, last)].append(prospect.id)
    for draft in drafts:
        matches = draft.existing_matches
        for email in draft.emails:
            for prospect_id in by_email.get(email.address, ()):
                matches.setdefault(prospect_id, set()).add(MatchReason.SAME_EMAIL)
        if key := person_key(draft):
            for prospect_id in by_name.get(key, ()):
                company_id = prospects[prospect_id].company_id
                same_company = (
                    draft.company is not None
                    and company_id is not None
                    and company_keys.get(company_id) == draft.company.match_key
                )
                reason = MatchReason.SAME_PERSON if same_company else MatchReason.SAME_NAME
                matches.setdefault(prospect_id, set()).add(reason)
        if not matches:
            continue
        draft.contactability = {pid: prospects[pid].contactability_status for pid in matches}
        reasons = set().union(*matches.values())
        if MatchReason.SAME_EMAIL in reasons:
            draft.flag(DiagnosticCode.DUPLICATE_EMAIL_EXISTING, ImportField.EMAIL)
        if MatchReason.SAME_PERSON in reasons:
            draft.flag(DiagnosticCode.DUPLICATE_PERSON_EXISTING)
        elif MatchReason.SAME_NAME in reasons and MatchReason.SAME_EMAIL not in reasons:
            draft.flag(DiagnosticCode.DUPLICATE_PERSON_NAME_EXISTING)
        blocked = [
            pid
            for pid, why in matches.items()
            if why & PERSON_REASONS and do_not_contact(draft, pid)
        ]
        if blocked:
            draft.blocked = True
            draft.flag(DiagnosticCode.CONTACTABILITY_DO_NOT_CONTACT)
        elif any(do_not_contact(draft, pid) for pid in matches):
            draft.flag(DiagnosticCode.CONTACTABILITY_POSSIBLE_DO_NOT_CONTACT)


def do_not_contact(draft: RowDraft, prospect_id: uuid.UUID) -> bool:
    return draft.contactability[prospect_id] is ContactabilityStatus.DO_NOT_CONTACT


def existing_companies(drafts: Sequence[RowDraft], companies: Sequence[ReferenceCompany]) -> None:
    by_key: dict[str, list[ReferenceCompany]] = defaultdict(list)
    by_domain: dict[str, list[ReferenceCompany]] = defaultdict(list)
    for company in companies:
        names = (company.display_name, company.legal_name)
        for key in sorted({company_key(name) for name in names if name}):
            by_key[key].append(company)
        if company.email_domain:
            by_domain[company.email_domain].append(company)
    similar_cache: dict[str, list[ReferenceCompany]] = {}
    for draft in drafts:
        proposal = draft.company
        if proposal is None:
            continue
        key = proposal.match_key
        if key not in similar_cache:
            similar_cache[key] = [
                company
                for other_key, found in sorted(by_key.items())
                if other_key != key and similarity(key, other_key) >= COMPANY_SIMILARITY
                for company in found
            ]
        exact = by_key.get(key, [])
        add_candidates(draft, exact, MatchReason.SAME_COMPANY_NAME)
        for company in exact:
            if fold(company.display_name) == fold(proposal.display_name):
                name, reasons, _ = draft.company_candidates[company.id]
                draft.company_candidates[company.id] = (name, reasons, 1.0)
        if proposal.email_domain:
            add_candidates(
                draft, by_domain.get(proposal.email_domain, []), MatchReason.SAME_EMAIL_DOMAIN
            )
        add_candidates(draft, similar_cache[key], MatchReason.SIMILAR_COMPANY_NAME)
        if exact:
            draft.flag(DiagnosticCode.COMPANY_EXISTING_MATCH, ImportField.COMPANY_NAME)
        elif draft.company_candidates:
            draft.flag(DiagnosticCode.COMPANY_LIKELY_MATCH, ImportField.COMPANY_NAME)


def add_candidates(
    draft: RowDraft, companies: Iterable[ReferenceCompany], reason: MatchReason
) -> None:
    for company in companies:
        name, reasons, confidence = draft.company_candidates.get(
            company.id, (company.display_name, set(), 0.0)
        )
        reasons.add(reason)
        draft.company_candidates[company.id] = (
            name,
            reasons,
            max(confidence, REASON_CONFIDENCE[reason]),
        )
