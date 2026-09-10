"""Duplicate candidates (in file and against reference data) and do-not-contact blocking."""

import dataclasses
from typing import Any

from app.models.enums import ContactabilityStatus
from app.services.imports.diagnostics import DiagnosticCode as Code
from app.services.imports.models import CandidateKind, ImportPreview, MatchReason, PreviewRow
from app.services.imports.preview import ImportFile, build_preview
from app.services.imports.reference import EMPTY_REFERENCE, ImportReferenceData, ReferenceCompany
from tests.fixtures.synthetic.legacy_workbook import ID, REFERENCE, legacy_xlsx


def preview_of(
    rows: list[dict[str, Any]], reference: ImportReferenceData = REFERENCE
) -> ImportPreview:
    return build_preview(ImportFile("dedup.xlsx", legacy_xlsx(rows)), reference)


def person(first: str, last: str, company: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"first_name": first, "last_name": last, "company": company, **extra}


def codes(row: PreviewRow) -> list[Code]:
    return [diagnostic.code for diagnostic in row.diagnostics]


def test_in_file_email_groups_link_every_row_of_the_group() -> None:
    result = preview_of(
        [
            person("Jean", "Test", "Exemple", email="jean.test@example.com"),
            person("Jeanne", "Test", "Exemple", email=" JEAN.TEST@example.com "),
            person("J.", "Test", "Autre", email="autre@example.com; jean.test@example.com"),
            person("Luc", "Seul", "Exemple", email="luc.seul@example.com"),
        ],
        EMPTY_REFERENCE,
    )

    assert result.summary.duplicate_email_groups == 1
    assert [[d.row for d in r.duplicates] for r in result.rows] == [[3, 4], [2, 4], [2, 3], []]
    assert [codes(r).count(Code.DUPLICATE_EMAIL_IN_FILE) for r in result.rows] == [1, 1, 1, 0]


def test_same_person_in_file_needs_names_and_company() -> None:
    result = preview_of(
        [
            person("Jean", "TEST", "Transports Exemple SARL"),
            person("jean", "Test", "TRANSPORTS EXEMPLE"),
            person("Jean", "Test", "Fret Modèle"),
            person("Jean", "Test"),
        ],
        EMPTY_REFERENCE,
    )

    first, second, other_company, no_company = result.rows
    assert [(d.row, d.reasons) for d in first.duplicates] == [(3, [MatchReason.SAME_PERSON])]
    assert Code.DUPLICATE_PERSON_IN_FILE in codes(second)
    assert other_company.duplicates == [] and no_company.duplicates == []


def test_company_variants_and_conflicting_company_values() -> None:
    result = preview_of(
        [
            person("Jean", "Test", "Transports Exemple SARL", project_done="Oui"),
            person("Marc", "Démo", "TRANSPORTS EXEMPLE S.A.R.L.", project_done="Non"),
            person("Léa", "Essai", "Transports Exemple SARL"),
        ],
        EMPTY_REFERENCE,
    )

    assert [Code.COMPANY_VARIANT_IN_FILE in codes(r) for r in result.rows] == [True] * 3
    conflicts = [
        [d.field for d in r.diagnostics if d.code is Code.COMPANY_FIELD_CONFLICT]
        for r in result.rows
    ]
    assert conflicts == [["project_done_with_circoe"], ["project_done_with_circoe"], []]


def test_existing_email_and_same_person_are_candidates_not_decisions() -> None:
    result = preview_of(
        [
            person("Lucas", "Autre", "Nouvelle Société", email="luc.exemple@example.com"),
            person("Luc", "EXEMPLE", "Logistique Démo"),
            person("Luc", "Exemple", "Fret Modèle"),
        ]
    )

    by_email, same_person, homonym = result.rows
    (candidate,) = by_email.duplicates
    assert (candidate.kind, candidate.prospect_id) == (
        CandidateKind.EXISTING_PROSPECT,
        ID["prospect-luc"],
    )
    assert candidate.reasons == [MatchReason.SAME_EMAIL] and candidate.confidence == 1.0
    assert candidate.contactability is ContactabilityStatus.CONTACTABLE
    assert Code.DUPLICATE_EMAIL_EXISTING in codes(by_email)
    assert [(d.reasons, d.confidence) for d in same_person.duplicates] == [
        ([MatchReason.SAME_PERSON], 0.9)
    ]
    assert Code.DUPLICATE_PERSON_EXISTING in codes(same_person)
    assert [(d.reasons, d.confidence) for d in homonym.duplicates] == [
        ([MatchReason.SAME_NAME], 0.5)
    ]
    assert Code.DUPLICATE_PERSON_NAME_EXISTING in codes(homonym)
    assert not any(r.blocked_by_do_not_contact for r in result.rows)


def test_do_not_contact_blocks_by_email_or_by_name_and_company() -> None:
    result = preview_of(
        [
            person("Autre", "Personne", "Ailleurs", email="bruno.bloque@logistique-demo.example"),
            person("Bruno", "BLOQUE", "Logistique Démo SAS"),
            person("Bruno", "Bloqué", "Autre Société"),
        ]
    )

    by_email, by_person, homonym = result.rows
    for row in (by_email, by_person):
        assert row.blocked_by_do_not_contact and row.status == "error"
        assert Code.CONTACTABILITY_DO_NOT_CONTACT in codes(row)
        assert row.duplicates[0].contactability is ContactabilityStatus.DO_NOT_CONTACT
    assert not homonym.blocked_by_do_not_contact
    assert Code.CONTACTABILITY_POSSIBLE_DO_NOT_CONTACT in codes(homonym)


def test_company_candidates_by_key_domain_and_spelling() -> None:
    reference = dataclasses.replace(
        REFERENCE,
        companies=(
            *REFERENCE.companies,
            ReferenceCompany(
                ID["company-sample"], "Transports Échantillon", "TE SAS", "te.example"
            ),
        ),
    )
    result = preview_of(
        [
            person("A", "Un", "logistique demo", email="a.un@logistique-demo.example"),
            person("B", "Deux", "Société Inconnue", email="b.deux@te.example"),
            person("C", "Trois", "Transport Echantillon"),
            person("D", "Quatre", "Fret Modèle", email="d.quatre@gmail.com"),
        ],
        reference,
    )

    key, domain, spelling, none = (r.company for r in result.rows)
    assert key is not None and domain is not None and spelling is not None and none is not None
    assert [(c.company_id, c.reasons, c.confidence) for c in key.candidates] == [
        (ID["company-demo"], [MatchReason.SAME_COMPANY_NAME, MatchReason.SAME_EMAIL_DOMAIN], 0.9)
    ]
    assert Code.COMPANY_EXISTING_MATCH in codes(result.rows[0])
    assert [(c.reasons, c.confidence) for c in domain.candidates] == [
        ([MatchReason.SAME_EMAIL_DOMAIN], 0.7)
    ]
    assert [c.reasons for c in spelling.candidates] == [[MatchReason.SIMILAR_COMPANY_NAME]]
    assert Code.COMPANY_LIKELY_MATCH in codes(result.rows[2])
    assert none.email_domain is None and none.candidates == []  # webmail says nothing


def test_identical_existing_name_has_full_confidence() -> None:
    result = preview_of([person("A", "Un", "Logistique Démo SAS")])

    company = result.rows[0].company
    assert company is not None and [c.confidence for c in company.candidates] == [1.0]
