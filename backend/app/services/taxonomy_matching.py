"""Pure matching of a raw taxonomy value (what an agent wrote) against existing labels.

Levels, first hit wins, and an ambiguous hit never counts (the caller then proposes a new value):

1. exact — same text once case, accents, punctuation and spacing are ignored;
2. variant — masculine/feminine, plural, acronyms and well-known business synonyms (« DRH » ↔
   « Directeur des ressources humaines »);
3. close spelling — near-identical text (typos), with a high threshold.

No database and no model here: the service (`taxonomies.resolve_value`) feeds it the labels.
"""

import re
import unicodedata
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from enum import StrEnum


class ResolutionKind(StrEnum):
    EXACT = "exact"
    MATCHED = "matched"
    NEW = "new"


@dataclass(frozen=True, slots=True)
class Candidate:
    id: uuid.UUID
    label: str


@dataclass(frozen=True, slots=True)
class Match:
    kind: ResolutionKind
    candidate: Candidate | None
    confidence: float
    reason: str


STOPWORDS = frozenset(
    {"de", "des", "du", "la", "le", "les", "l", "d", "et", "of", "the", "and", "en"}
)
# Acronym -> expansion (compared as a normal label afterwards).
ACRONYMS: dict[str, str] = {
    "drh": "directeur des ressources humaines",
    "rrh": "responsable des ressources humaines",
    "daf": "directeur administratif et financier",
    "dsi": "directeur des systemes d information",
    "dg": "directeur general",
    "pdg": "president directeur general",
    "dga": "directeur general adjoint",
    "dc": "directeur commercial",
    "dirco": "directeur commercial",
    "dt": "directeur technique",
    "dir": "directeur",
    "ceo": "directeur general",
    "cfo": "directeur financier",
    "cto": "directeur technique",
    "coo": "directeur des operations",
    "chro": "directeur des ressources humaines",
    "cio": "directeur des systemes d information",
    "rh": "ressources humaines",
}
# Word -> canonical word (business synonyms and gendered forms), applied token by token.
SYNONYMS: dict[str, str] = {
    "directrice": "directeur",
    "directeurs": "directeur",
    "directrices": "directeur",
    "dirigeante": "dirigeant",
    "responsables": "responsable",
    "presidente": "president",
    "gerante": "gerant",
    "director": "directeur",
    "hr": "rh",
    "human": "humaines",
    "resources": "ressources",
    "logistics": "logistique",
    "purchasing": "achats",
    "achat": "achats",
}
CLOSE_THRESHOLD = 0.92


def fold(value: str) -> str:
    """Lowercase, accents removed, every run of other characters turned into one space."""
    decomposed = unicodedata.normalize("NFKD", value)
    plain = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", plain.casefold()).strip()


def _token(word: str) -> str:
    word = SYNONYMS.get(word, word)
    word = re.sub(r"trice$", "teur", word)
    if len(word) > 4 and word.endswith("s"):
        word = word[:-1]
    return word


def canonical(value: str) -> str:
    """The comparison form of a label: folded, acronym expanded, gender/plural/synonyms unified."""
    folded = fold(value)
    folded = ACRONYMS.get(folded.replace(" ", ""), folded)
    tokens = [_token(word) for word in folded.split() if word not in STOPWORDS]
    return " ".join(tokens)


def _acronym(label: str) -> str:
    return "".join(word[0] for word in fold(label).split() if word not in STOPWORDS)


def match_label(raw: str, candidates: Sequence[Candidate]) -> Match:
    """Best existing value for `raw`, or a `NEW` match when nothing is sure enough."""
    folded = fold(raw)
    if not folded:
        return Match(ResolutionKind.NEW, None, 0.0, "empty")
    exact = [c for c in candidates if fold(c.label) == folded]
    if len(exact) == 1:
        return Match(ResolutionKind.EXACT, exact[0], 1.0, "same text")
    if exact:
        return Match(ResolutionKind.NEW, None, 0.0, "ambiguous")

    target = canonical(raw)
    variants = [c for c in candidates if canonical(c.label) == target]
    if not variants and " " not in folded and 2 <= len(folded) <= 6:
        # An unknown acronym matches a label made of its initials (DOP = Directeur des opérations).
        variants = [c for c in candidates if _acronym(c.label) == folded]
    if len(variants) == 1:
        reason = "acronym, gender or synonym variant"
        return Match(ResolutionKind.MATCHED, variants[0], 0.9, reason)
    if variants:
        return Match(ResolutionKind.NEW, None, 0.0, "ambiguous")

    scored = sorted(
        ((SequenceMatcher(None, target, canonical(c.label)).ratio(), c) for c in candidates),
        key=lambda pair: pair[0],
        reverse=True,
    )
    if scored and scored[0][0] >= CLOSE_THRESHOLD:
        runner_up = scored[1][0] if len(scored) > 1 else 0.0
        if runner_up < CLOSE_THRESHOLD:
            best = round(scored[0][0], 2)
            return Match(ResolutionKind.MATCHED, scored[0][1], best, "close spelling")
    return Match(ResolutionKind.NEW, None, 0.0, "no close value")
