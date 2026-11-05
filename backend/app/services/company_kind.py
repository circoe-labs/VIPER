"""Suggestion of a company's kind (PME / grande entreprise / institutionnel) from what is known.

A suggestion only: the kind is set by a person (company editor). Rules, in order:

1. the Excel category « Secteur public & institutions » (or a free text naming the public sector)
   suggests `institutional`;
2. a headcount read in `size_label` (« 50-249 salariés », « 12 », « 5000+ ») suggests `sme` below
   250 and `large` from 250 (ETI included); a range straddling 250 (« 100-400 ») gives nothing;
3. otherwise nothing (`None`): never a guess.
"""

import re
import unicodedata

from app.models.enums import CompanyKind

SME_MAX_EMPLOYEES = 249

_PUBLIC_MARKERS = ("secteur public", "institution", "collectivite", "administration", "mairie")
# Thousands separators: narrow no-break space (U+202F) and no-break space (U+00A0).
_THOUSANDS = "".join(chr(code) for code in (0x202F, 0x00A0))
_NUMBER = re.compile(rf"\d[\d\s.{_THOUSANDS}]*")


def _fold(text: str) -> str:
    stripped = unicodedata.normalize("NFD", text.casefold())
    return "".join(char for char in stripped if not unicodedata.combining(char))


def _numbers(text: str) -> list[int]:
    found = []
    for match in _NUMBER.finditer(text):
        digits = re.sub(r"\D", "", match.group())
        if digits:
            found.append(int(digits))
    return found


def kind_from_category(category: str | None) -> CompanyKind | None:
    if not category:
        return None
    folded = _fold(category)
    return CompanyKind.INSTITUTIONAL if any(m in folded for m in _PUBLIC_MARKERS) else None


def kind_from_size(size_label: str | None) -> CompanyKind | None:
    """`sme` when the whole range stays under 250, `large` when it starts at 250 or more, else
    None (a range straddling 250, or no number)."""
    if not size_label:
        return None
    numbers = _numbers(size_label)
    if not numbers:
        return None
    low, high = min(numbers), max(numbers)
    if "+" in size_label or ">" in size_label or "plus" in _fold(size_label):
        return CompanyKind.LARGE if max(numbers) > SME_MAX_EMPLOYEES else None
    if high <= SME_MAX_EMPLOYEES:
        return CompanyKind.SME
    if low > SME_MAX_EMPLOYEES:
        return CompanyKind.LARGE
    return None


def suggest_company_kind(
    *, category: str | None = None, size_label: str | None = None
) -> CompanyKind | None:
    return kind_from_category(category) or kind_from_size(size_label)
