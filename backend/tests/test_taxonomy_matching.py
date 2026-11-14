import uuid

import pytest

from app.services.taxonomy_matching import Candidate, ResolutionKind, match_label

LABELS = [
    "Directeur des ressources humaines",
    "Directeur logistique",
    "Responsable qualité",
    "Directeur financier",
]
CANDIDATES = [Candidate(uuid.uuid4(), label) for label in LABELS]


@pytest.mark.parametrize(
    ("raw", "label", "kind"),
    [
        ("DIRECTEUR LOGISTIQUE", "Directeur logistique", ResolutionKind.EXACT),
        ("DRH", LABELS[0], ResolutionKind.MATCHED),
        ("Directrice des ressources humaines", LABELS[0], ResolutionKind.MATCHED),
        ("Directrice logistique", "Directeur logistique", ResolutionKind.MATCHED),
        ("Responsable qualite", "Responsable qualité", ResolutionKind.EXACT),
        ("CFO", "Directeur financier", ResolutionKind.MATCHED),
    ],
)
def test_matches_existing_value(raw: str, label: str, kind: ResolutionKind) -> None:
    match = match_label(raw, CANDIDATES)
    assert match.kind is kind
    assert match.candidate is not None and match.candidate.label == label


UNKNOWN = ["Chief Transformation Officer", "Directeur", "", "Responsable achats"]


@pytest.mark.parametrize("raw", UNKNOWN)
def test_unknown_or_ambiguous_is_new(raw: str) -> None:
    match = match_label(raw, CANDIDATES)
    assert match.kind is ResolutionKind.NEW and match.candidate is None
