"""The import agent and the reading of a workbook through its plan. Every value is invented."""

import io
import json
from functools import cache
from typing import Any

import httpx2
import pytest
from openpyxl import Workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import Company, Establishment, Prospect
from app.models.imports import ImportRowMetadata
from app.models.prospects import ProspectNote, ProspectSource
from app.services import import_commit
from app.services.errors import MailGenerationError
from app.services.imports import agent
from app.services.imports.decisions import ImportDecisions, PreviewOptions
from app.services.imports.diagnostics import DiagnosticCode
from app.services.imports.layout import ImportMapping
from app.services.imports.plan import ImportPlanSpec
from app.services.imports.plan_reader import split_full_name
from app.services.imports.preview import ImportFile, build_preview
from app.services.imports.workbook import ImportLimits
from tests.builders import OPERATOR, add_company, with_key

LIMITS = ImportLimits()
SIREN = with_key("11111111")
SIRET_A = with_key(f"{SIREN}0001")
SIRET_B = with_key(f"{SIREN}0002")
# A SIRET starting with 0, as Excel keeps it when typed as a number.
SIRET_ZERO = with_key("0222222220001")


# Cached: openpyxl stamps the saving time, and a commit needs the very bytes it reviewed.
@cache
def workbook() -> bytes:
    """Two sheets with different, partly misspelt headers; a second person on the row below the
    company; a layout change in the middle of the second sheet."""
    book = Workbook()
    first = book.active
    assert first is not None
    first.title = "Feuil1"
    first.append(
        [
            "N°",
            "Société juridique",
            "Nom commercial",
            "SIRET",
            "Ville",
            "Téléphone",
            "Nom et prénom",
            "mail",
            "LinkedIn",
        ]
    )
    first.append(
        [
            1,
            "ALPHA TRANSIT SAS",
            "Alpha Transit",
            int(SIRET_A),
            "Le Havre",
            "02 35 00 00 01",
            "Alice DUPONT-ESSAI",
            "alice@alpha.example",
            "https://www.linkedin.com/in/alice-essai/",
        ]
    )
    first.append([None, None, None, None, None, None, "Jean Louis Essai", "jl@alpha.example"])
    first.append(
        [
            2,
            "ALPHA TRANSIT",
            "Alpha Transit Agence",
            int(SIRET_B),
            "Rouen",
            None,
            "Alice DUPONT-ESSAI",
            "alice@alpha.example",
        ]
    )
    first.append(
        [
            3,
            "BETA FRET",
            "Beta Fret",
            int(SIRET_ZERO),
            "Caen",
            "06 00",
            "Bob EXEMPLE",
            "bob@beta.example",
        ]
    )
    second = book.create_sheet("Feuil2")
    second.append(["entrepise", "Nom et prénom", "mail"])
    second.append(["ALPHA - Le Havre", "Chloé MODÈLE", "chloe@alpha.example"])
    second.append([27, "Gamma Assistance", "GAMMA SARL"])
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def columns(**mapping: str) -> list[dict[str, str]]:
    return [{"column": letter, "field": field} for letter, field in mapping.items()]


PLAN: dict[str, Any] = {
    "blocks": [
        {
            "sheet": "Feuil1",
            "header_row": 1,
            "first_row": 2,
            "last_row": 5,
            "columns": columns(
                B="legal_name",
                C="company_name",
                D="siret",
                E="city",
                F="phone",
                G="full_name",
                H="email",
                I="linkedin",
            ),
            "carry_down": ["F"],
        },
        {
            "sheet": "Feuil2",
            "header_row": 1,
            "first_row": 2,
            "last_row": 2,
            "columns": columns(A="company_name", B="full_name", C="email"),
            "carry_down": [],
        },
        {
            "sheet": "Feuil2",
            "header_row": None,
            "first_row": 3,
            "last_row": 3,
            "columns": columns(B="site_name", C="legal_name"),
            "carry_down": [],
        },
    ],
    "same_companies": [{"names": ["Alpha Transit", "ALPHA - Le Havre"]}],
    "names": [{"sheet": "Feuil1", "row": 3, "first_name": "Jean Louis", "last_name": "Essai"}],
    "notes": ["Un numéro est incomplet."],
}


def mapping() -> ImportMapping:
    return ImportMapping(plan=ImportPlanSpec.model_validate(PLAN))


def file() -> ImportFile:
    return ImportFile("fiche.xlsx", workbook())


def test_the_historical_reading_asks_for_the_agent_on_unknown_headers() -> None:
    preview = build_preview(file())

    assert preview.summary.agent_recommended


def test_the_plan_reads_every_sheet_and_carries_company_values_down() -> None:
    preview = build_preview(file(), mapping=mapping())
    rows = {(r.source_sheet, r.source_row): r for r in preview.rows}

    assert list(rows) == [
        ("Feuil1", 2),
        ("Feuil1", 3),
        ("Feuil1", 4),
        ("Feuil1", 5),
        ("Feuil2", 2),
        ("Feuil2", 3),
    ]
    assert len({r.row_number for r in preview.rows}) == len(preview.rows)
    second = rows["Feuil1", 3]
    assert second.company is not None and second.company.display_name == "Alpha Transit"
    assert second.company.siren == SIREN
    assert (second.prospect.first_name, second.prospect.last_name) == ("Jean Louis", "Essai")
    assert [p.number for p in second.phones] == ["+33235000001"]
    first = rows["Feuil1", 2].prospect
    assert (first.first_name, first.last_name) == ("Alice", "Dupont-Essai")
    assert first.linkedin_url == "https://www.linkedin.com/in/alice-essai/"


def test_one_company_across_sirets_spellings_and_sheets_and_duplicates_are_found() -> None:
    preview = build_preview(file(), mapping=mapping())
    rows = {(r.source_sheet, r.source_row): r for r in preview.rows}
    keys = {r.company.match_key for r in preview.rows if r.company and r.company.display_name != ""}
    alpha = [rows["Feuil1", n].company for n in (2, 3, 4)] + [rows["Feuil2", 2].company]

    assert len({c.match_key for c in alpha if c}) == 1 and len(keys) == 3
    again = rows["Feuil1", 4]
    assert [d.row for d in again.duplicates] == [rows["Feuil1", 2].row_number]
    # Another site of the same company starts a new block: nothing is carried into it.
    assert again.phones == []


def test_incomplete_values_are_reported_never_invented() -> None:
    preview = build_preview(file(), mapping=mapping())
    rows = {(r.source_sheet, r.source_row): r for r in preview.rows}

    beta = rows["Feuil1", 5]
    codes = {d.code for d in beta.diagnostics}
    assert DiagnosticCode.SIRET_LEADING_ZERO_RESTORED in codes
    assert DiagnosticCode.PHONE_INVALID in codes
    assert beta.company is not None and beta.company.establishment is not None
    assert beta.company.establishment.siret == SIRET_ZERO
    lonely = rows["Feuil2", 3]
    assert DiagnosticCode.COMPANY_WITHOUT_CONTACT in {d.code for d in lonely.diagnostics}
    assert lonely.company is not None and lonely.company.display_name == "GAMMA SARL"


def test_rows_the_plan_leaves_out_are_announced() -> None:
    partial = {**PLAN, "blocks": PLAN["blocks"][:1]}
    preview = build_preview(
        file(), mapping=ImportMapping(plan=ImportPlanSpec.model_validate(partial))
    )

    notices = [n for n in preview.summary.notices if n.code is DiagnosticCode.SHEET_ROWS_NOT_READ]
    assert len(notices) == 1 and "Feuil2" in notices[0].message


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Henri-Pierre MOURRAIN", ("Henri-Pierre", "MOURRAIN")),
        ("Mathieu LE MOAL", ("Mathieu", "LE MOAL")),
        ("Remi Chevassus", ("Remi", "Chevassus")),
        ("DUPONT", ("", "DUPONT")),
    ],
)
def test_full_names_are_split(text: str, expected: tuple[str, str]) -> None:
    assert split_full_name(text) == expected


def commit(session: Session) -> import_commit.CommitResult:
    options = PreviewOptions(mapping=mapping())
    review, _ = import_commit.review_upload(session, file(), options, LIMITS)
    decisions = ImportDecisions(
        mapping=options.mapping,
        file_fingerprint=review.preview.summary.file_fingerprint,
        preview_digest=review.digest,
        legal_basis_or_collection_context="Essai",
    )
    return import_commit.commit_import(session, OPERATOR, file(), decisions, LIMITS)


def test_commit_writes_companies_sites_people_notes_and_the_true_row_locations(
    db_session: Session,
) -> None:
    result = commit(db_session)

    assert result.counts["companies_created"] == 2
    assert result.counts["prospects_created"] == 4
    assert result.counts["rows_merged"] == 1
    alpha = db_session.scalars(select(Company).where(Company.siren == SIREN)).one()
    assert (alpha.display_name, alpha.legal_name) == ("Alpha Transit", "ALPHA TRANSIT SAS")
    sites = db_session.scalars(
        select(Establishment.siret).where(Establishment.company_id == alpha.id)
    ).all()
    assert set(sites) == {SIRET_A, SIRET_B}
    assert (
        len(db_session.scalars(select(Prospect).where(Prospect.company_id == alpha.id)).all()) == 3
    )
    notes = db_session.scalars(select(ProspectNote.fact_text)).all()
    assert notes == ["Profil LinkedIn : https://www.linkedin.com/in/alice-essai/"]
    traced = db_session.execute(
        select(ImportRowMetadata.source_sheet, ImportRowMetadata.source_row_number)
    ).all()
    assert ("Feuil2", 2) in {tuple(row) for row in traced}
    sources = db_session.scalars(select(ProspectSource.source_reference)).all()
    assert "fiche.xlsx / Feuil2 / ligne 2" in sources
    assert result.batch.sheet_names == ["Feuil1", "Feuil2"]


def test_a_company_known_by_its_siren_is_completed_not_recreated(db_session: Session) -> None:
    known = add_company(db_session, "Ancien nom", siren=SIREN)

    result = commit(db_session)

    assert (result.counts["companies_linked"], result.counts["companies_created"]) == (1, 1)
    db_session.refresh(known)
    assert (known.display_name, known.legal_name) == ("Ancien nom", "ALPHA TRANSIT SAS")


# --- the agent -----------------------------------------------------------------------------------


def settings() -> Settings:
    return Settings(openai_api_key="sk-test", openai_model="test-model")


def answering(*plans: dict[str, Any]) -> tuple[httpx2.MockTransport, list[dict[str, Any]]]:
    sent: list[dict[str, Any]] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        sent.append(json.loads(request.content))
        plan = plans[min(len(sent), len(plans)) - 1]
        content = [{"type": "output_text", "text": json.dumps(plan)}]
        return httpx2.Response(
            200,
            json={"status": "completed", "output": [{"type": "message", "content": content}]},
        )

    return httpx2.MockTransport(handle), sent


def test_the_agent_sees_every_sheet_and_gets_a_second_look_at_unread_rows() -> None:
    transport, sent = answering({**PLAN, "blocks": PLAN["blocks"][:1]}, PLAN)

    answer = agent.analyze("fiche.xlsx", workbook(), settings(), LIMITS, transport=transport)

    assert len(answer.plan.blocks) == 3 and len(sent) == 2
    assert '"Feuil2"' in sent[0]["input"] and "entrepise" in sent[0]["input"]
    assert "Elle ne lit pas ces lignes" in sent[1]["input"]
    assert sent[0]["store"] is False and sent[0]["text"]["format"]["strict"] is True


def test_the_agent_refuses_when_ai_is_not_configured() -> None:
    with pytest.raises(MailGenerationError) as error:
        agent.analyze("fiche.xlsx", workbook(), Settings(), LIMITS)

    assert error.value.code == "ai_not_configured"


def test_an_unusable_plan_is_a_typed_error() -> None:
    transport, _ = answering({"blocks": "non"})

    with pytest.raises(MailGenerationError) as error:
        agent.analyze("fiche.xlsx", workbook(), settings(), LIMITS, transport=transport)

    assert error.value.code == "ai_invalid_output"
