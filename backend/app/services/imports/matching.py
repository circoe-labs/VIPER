"""Matching free text against reference data: roles, activity categories, commercial segments,
internal referents, and the company key used for company dedup. Suggestions only — the engine
never creates a taxonomy value or a referent.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher

from app.services.imports.diagnostics import DiagnosticCode
from app.services.imports.models import MatchKind, ReferentMatch, TaxonomyMatch
from app.services.imports.normalize import WEEK, Codes, suggests_inactive
from app.services.imports.reference import ReferenceReferent, ReferenceTaxonomy
from app.services.imports.text import CellValue, fold, single_line

SIMILARITY_THRESHOLD = 0.8
CONTAINS_SCORE = 0.9


def similarity(left: str, right: str) -> float:
    matcher = SequenceMatcher(None, left, right, autojunk=False)
    if matcher.real_quick_ratio() < SIMILARITY_THRESHOLD:
        return 0.0
    if matcher.quick_ratio() < SIMILARITY_THRESHOLD:
        return 0.0
    return round(matcher.ratio(), 3)


def taxonomy_match(
    value: ReferenceTaxonomy, match: MatchKind, score: float, text: str
) -> TaxonomyMatch:
    return TaxonomyMatch(
        id=value.id,
        label=value.label,
        match=match,
        score=score,
        requires_confirmation=match is not MatchKind.EXACT,
        source_text=text,
    )


def match_taxonomy(text: str, values: Sequence[ReferenceTaxonomy]) -> list[TaxonomyMatch]:
    """Exact (folded label or slug) on active values; else exact on inactive ones; else ranked
    suggestions: every label word present in the text, or a close spelling."""
    key = fold(text)
    if not key:
        return []
    exact = [v for v in values if fold(v.label) == key or v.slug == key.replace(" ", "-")]
    for active in (True, False):
        found = sorted((v for v in exact if v.active is active), key=lambda v: v.label)
        if found:
            kind = MatchKind.EXACT if active else MatchKind.INACTIVE
            return [taxonomy_match(v, kind, 1.0, text) for v in found]
    words = set(key.split())
    suggestions = []
    for value in values:
        if not value.active:
            continue
        label = fold(value.label)
        if set(label.split()) <= words:
            suggestions.append(taxonomy_match(value, MatchKind.CONTAINS, CONTAINS_SCORE, text))
        elif score := similarity(key, label):
            suggestions.append(taxonomy_match(value, MatchKind.SIMILAR, score, text))
    return sorted(suggestions, key=lambda match: (-match.score, match.label))


# --- Role (`Fonction`) --------------------------------------------------------------------------


def match_role(title: str, roles: Sequence[ReferenceTaxonomy]) -> tuple[list[TaxonomyMatch], Codes]:
    matches = match_taxonomy(title, roles)
    if not matches:
        return [], (DiagnosticCode.ROLE_UNMATCHED,)
    if matches[0].match is MatchKind.EXACT:
        return matches[:1], ()
    if matches[0].match is MatchKind.INACTIVE:
        return matches, (DiagnosticCode.ROLE_INACTIVE_MATCH,)
    return matches, (DiagnosticCode.ROLE_SUGGESTED,)


# --- Activity categories (`Catégorie`) ----------------------------------------------------------

# One cell may list several categories; `&` and `et` are NOT separators: historical labels use
# them (`1. Transport & Logistique`, `Entreposage et stockage`).
CATEGORY_SEPARATORS = re.compile(r"\s*[/;|+\n,]\s*")
NUMBER_PREFIX = re.compile(r"^\s*[0-9]+\s*[.)\-:]\s*")
NOT_A_CATEGORY = frozenset(
    {"non", "oui", "x", "xx", "xxx", "v", "ok", "nc", "na", "n a", "aucun", "aucune", "rien"}
    | {"ras", "autre", "autres", "divers", "inconnu"}
)


@dataclass(frozen=True, slots=True)
class CategoryOutcome:
    matches: tuple[TaxonomyMatch, ...] = ()
    unmatched: tuple[str, ...] = ()
    segment: TaxonomyMatch | None = None
    codes: Codes = ()
    keep_raw: bool = False


def category_tokens(text: str) -> list[str]:
    tokens = [NUMBER_PREFIX.sub("", token).strip() for token in CATEGORY_SEPARATORS.split(text)]
    return [token for token in tokens if token]


def is_not_a_category(text: str) -> bool:
    key = fold(text)
    return not key or key in NOT_A_CATEGORY or key.replace(" ", "").isdigit()


def match_categories(
    value: CellValue,
    categories: Sequence[ReferenceTaxonomy],
    segments: Sequence[ReferenceTaxonomy],
) -> CategoryOutcome:
    """The whole cell (numeric prefix `1. ` removed) is tried first, then its `/`, `;`, `,`,
    `+`, `|` or newline separated parts. Each part gets an exact match, a suggestion to confirm,
    a commercial-segment suggestion, or stays unmatched; yes/no markers are not categories."""
    text = single_line(value) or ""
    whole = NUMBER_PREFIX.sub("", text).strip()
    if is_not_a_category(whole):
        return CategoryOutcome(codes=(DiagnosticCode.CATEGORY_INVALID,), keep_raw=True)
    first = match_taxonomy(whole, categories)
    exact_whole = first and first[0].match in (MatchKind.EXACT, MatchKind.INACTIVE)
    tokens = [whole] if exact_whole else category_tokens(text)
    matches: list[TaxonomyMatch] = []
    unmatched: list[str] = []
    segment: TaxonomyMatch | None = None
    codes: list[DiagnosticCode] = []

    def flag(code: DiagnosticCode) -> None:
        if code not in codes:
            codes.append(code)

    for token in tokens:
        if is_not_a_category(token):
            flag(DiagnosticCode.CATEGORY_INVALID)
            continue
        found = match_taxonomy(token, categories)
        if found:
            best = found[0]
            if all(match.id != best.id for match in matches):
                matches.append(best)
            if best.match is MatchKind.INACTIVE:
                flag(DiagnosticCode.CATEGORY_INACTIVE_MATCH)
            elif best.match is not MatchKind.EXACT:
                flag(DiagnosticCode.CATEGORY_SUGGESTED)
            continue
        as_segment = [m for m in match_taxonomy(token, segments) if m.match is MatchKind.EXACT]
        if as_segment and segment is None:
            segment = as_segment[0].model_copy(update={"requires_confirmation": True})
            flag(DiagnosticCode.CATEGORY_SEGMENT_SUGGESTED)
        else:
            unmatched.append(token)
            flag(DiagnosticCode.CATEGORY_UNMATCHED)
    fully_matched = not codes
    return CategoryOutcome(
        tuple(matches), tuple(unmatched), segment, tuple(codes), keep_raw=not fully_matched
    )


# --- Internal referent (`Référent`) -------------------------------------------------------------

REFERENT_MARKERS = frozenset({"v", "vv", "x", "xx", "xxx", "ok", "nc", "na", "n a"})
# Words that make a short text a note, not a person's name.
NOTE_WORDS = frozenset({"rdv", "rappel", "rappeler", "relance", "appel", "voir", "mail", "tel"})
# One to three words of letters (hyphens, apostrophes, dots allowed): could be a person.
NAME_LIKE = re.compile(r"[^\W\d_]+(?:[ '.-]+[^\W\d_]+){0,2}\.?")


@dataclass(frozen=True, slots=True)
class ReferentOutcome:
    match: ReferentMatch | None = None
    suggestions: tuple[ReferentMatch, ...] = ()
    codes: Codes = ()
    keep_raw: bool = False
    suggests_inactive: bool = False


def referent_match(referent: ReferenceReferent, kind: MatchKind) -> ReferentMatch:
    return ReferentMatch(
        id=referent.id,
        display=referent.display,
        match=kind,
        requires_confirmation=kind is not MatchKind.EXACT,
    )


def referent_keys(referent: ReferenceReferent) -> tuple[set[str], set[str]]:
    """(full-name keys, partial keys: first name, last name, initial + last name)."""
    first, last = fold(referent.first_name), fold(referent.last_name)
    initial = first[:1]
    full = {f"{first} {last}", f"{last} {first}"}
    return full, {first, last, f"{initial} {last}", f"{last} {initial}"}


def match_referent(value: CellValue, referents: Sequence[ReferenceReferent]) -> ReferentOutcome:
    """Only a recognised internal referent becomes a Referent. Legacy markers (`v`, `xxx`, `?`),
    email-like text, week codes and notes never do: they are flagged and kept raw."""
    text = single_line(value) or ""
    key = fold(text)
    if not key or key in REFERENT_MARKERS:
        return ReferentOutcome(codes=(DiagnosticCode.REFERENT_MARKER,), keep_raw=True)
    if "@" in text:
        return ReferentOutcome(codes=(DiagnosticCode.REFERENT_EMAIL_LIKE,), keep_raw=True)
    if WEEK.fullmatch(key):
        return ReferentOutcome(codes=(DiagnosticCode.REFERENT_WEEK_MARKER,), keep_raw=True)
    for active in (True, False):
        pool = sorted(
            (r for r in referents if r.active is active), key=lambda r: (r.display, str(r.id))
        )
        full = [r for r in pool if key in referent_keys(r)[0]]
        partial = [r for r in pool if key in referent_keys(r)[1]]
        found, kind = (full, MatchKind.EXACT) if full else (partial, MatchKind.PARTIAL)
        if not found:
            continue
        if not active:
            kind = MatchKind.INACTIVE
        suggestions = tuple(referent_match(r, kind) for r in found)
        if len(found) > 1:
            return ReferentOutcome(
                suggestions=suggestions, codes=(DiagnosticCode.REFERENT_AMBIGUOUS,), keep_raw=True
            )
        code = {
            MatchKind.EXACT: (),
            MatchKind.PARTIAL: (DiagnosticCode.REFERENT_PARTIAL_MATCH,),
            MatchKind.INACTIVE: (DiagnosticCode.REFERENT_INACTIVE,),
        }[kind]
        return ReferentOutcome(suggestions[0], suggestions, code, keep_raw=bool(code))
    if (
        NAME_LIKE.fullmatch(text)
        and not NOTE_WORDS & set(key.split())
        and not suggests_inactive(text)
    ):
        return ReferentOutcome(codes=(DiagnosticCode.REFERENT_UNKNOWN,), keep_raw=True)
    return ReferentOutcome(
        codes=(DiagnosticCode.REFERENT_NOTE,),
        keep_raw=True,
        suggests_inactive=suggests_inactive(text),
    )


# --- Company key --------------------------------------------------------------------------------

LEGAL_FORMS = frozenset(
    {"sarl", "sas", "sasu", "sa", "eurl", "snc", "sci", "scop", "sca", "scs", "gie", "selarl"}
    | {"eirl", "ei", "sem", "ste", "societe", "gmbh", "ltd", "llc", "inc", "bv", "nv", "spa"}
)


def company_key(name: str) -> str:
    """Folded name without legal forms (`SARL`, `S.A.S.`, `Sté`…): `Transports Exemple SARL`,
    `TRANSPORTS EXEMPLE` and `Transports Exemple S.A.R.L.` share one key; `&` counts as `et`."""
    folded = fold(name.replace(".", "").replace("&", " et "))
    words = [word for word in folded.split() if word not in LEGAL_FORMS]
    return " ".join(words) or folded
