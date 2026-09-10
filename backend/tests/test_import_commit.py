"""Import review and transactional commit (Task 09) against the real test database. Synthetic
workbooks only (`tests/fixtures/synthetic/legacy_workbook.py`); every value is invented."""

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models import (
    ActivityCategory,
    Company,
    ContactTracking,
    Email,
    Establishment,
    ImportBatch,
    ImportRowMetadata,
    Phone,
    Prospect,
    ProspectSource,
    Role,
)
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactTrackingStatus,
    ImportBatchStatus,
    OriginType,
    VerificationStatus,
)
from app.services import import_commit, provenance
from app.services.errors import DuplicateValueError
from app.services.imports.decisions import ImportDecisions, PreviewOptions
from app.services.imports.diagnostics import DiagnosticCode, ImportRejectedError
from app.services.imports.models import LegacyReason
from app.services.imports.preview import ImportFile
from app.services.imports.review import DecisionErrorCode, ImportReview
from app.services.imports.workbook import ImportLimits
from tests.builders import (
    OPERATOR,
    add_company,
    audit_events,
    bind_operator,
)
from tests.fixtures.synthetic.legacy_workbook import SAMPLE_ROWS, Row, legacy_xlsx
from tests.import_support import FILENAME, LEGAL_BASIS, SHEET, seed

LIMITS = ImportLimits()
PARIS = ZoneInfo("Europe/Paris")


@pytest.fixture
def ids(db_session: Session) -> dict[str, uuid.UUID]:
    found = seed(db_session)
    bind_operator(db_session)
    return found


def upload(rows: Sequence[Row] = SAMPLE_ROWS, filename: str = FILENAME) -> ImportFile:
    return ImportFile(filename, legacy_xlsx(rows))


def review_of(
    session: Session, file: ImportFile, options: PreviewOptions | None = None
) -> ImportReview:
    review, _ = import_commit.review_upload(session, file, options or PreviewOptions(), LIMITS)
    return review


def decide(review: ImportReview, **fields: Any) -> ImportDecisions:
    fields.setdefault("legal_basis_or_collection_context", LEGAL_BASIS)
    return ImportDecisions.model_validate(
        {
            "file_fingerprint": review.preview.summary.file_fingerprint,
            "preview_digest": review.digest,
            **fields,
        }
    )


def commit(
    session: Session, file: ImportFile, review: ImportReview, **fields: Any
) -> import_commit.CommitResult:
    return import_commit.commit_import(session, OPERATOR, file, decide(review, **fields), LIMITS)


def resolution(action: str, **fields: Any) -> dict[str, Any]:
    return {"resolution": {"action": action, **fields}}


def excluded(*numbers: int) -> dict[int, dict[str, Any]]:
    return {number: resolution("exclude") for number in numbers}


def refused(
    session: Session, file: ImportFile, review: ImportReview, **fields: Any
) -> set[tuple[DecisionErrorCode, int | None]]:
    with pytest.raises(import_commit.InvalidDecisionsError) as caught:
        commit(session, file, review, **fields)
    return {(error.code, error.row) for error in caught.value.errors}


def count(session: Session, model: type[Any], *where: Any) -> int:
    return session.scalar(select(func.count()).select_from(model).where(*where)) or 0


def person(session: Session, first: str, last: str) -> Prospect:
    """The prospect an import row created or completed (the seed has a homonym of Nina)."""
    return session.scalars(
        select(Prospect).where(
            Prospect.first_name == first,
            Prospect.last_name == last,
            Prospect.id.in_(select(ImportRowMetadata.prospect_id)),
        )
    ).one()


def key_of(review: ImportReview, group: str, text: str) -> str:
    key: str = next(g.key for g in getattr(review, group) if g.text == text)
    return key


def trace(session: Session, row: int) -> ImportRowMetadata:
    return session.scalars(
        select(ImportRowMetadata).where(ImportRowMetadata.source_row_number == row)
    ).one()


def tracking(session: Session, prospect: Prospect) -> ContactTracking | None:
    return session.scalars(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect.id)
    ).one_or_none()


PERSON = {"company": "Transports Témoin", "civility": "M.", "last_name": "Essai"}


# --- defaults ----------------------------------------------------------------------------------


def test_default_commit_creates_normalized_entities_with_provenance(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)

    result = commit(db_session, file, review, rows=excluded(10))

    batch = result.batch
    assert batch.status is ImportBatchStatus.COMMITTED and batch.committed_at is not None
    assert (batch.rows_total, batch.rows_imported, batch.rows_skipped) == (10, 8, 2)
    assert batch.filename == FILENAME and batch.sheet_names == [SHEET]
    assert batch.file_fingerprint == review.preview.summary.file_fingerprint
    assert batch.legal_basis_or_collection_context == LEGAL_BASIS
    assert (batch.actor_type, batch.actor_id) == (ActorType.HUMAN, OPERATOR.id)
    assert result.counts | {"rows_total": 10} == result.counts
    assert (result.counts["prospects_created"], result.counts["companies_created"]) == (8, 5)
    jean = person(db_session, "Jean", "Test")
    assert (jean.civility, jean.role_id, jean.exact_job_title) == (
        Civility.MR,
        ids["transport"],
        "Responsable transport",
    )
    assert jean.employment_verified_at is None
    assert jean.activity_status is ActivityStatus.UNKNOWN
    assert jean.contactability_status is ContactabilityStatus.CONTACTABLE
    emails = db_session.scalars(select(Email).where(Email.prospect_id == jean.id)).all()
    assert [(e.address, e.is_primary, e.origin_type, e.verification_status) for e in emails] == [
        ("jean.test@example.com", True, OriginType.IMPORTED, VerificationStatus.UNVERIFIED)
    ]
    reference = f"{FILENAME} / {SHEET} / ligne 2"
    assert emails[0].source_reference == reference
    phones = db_session.scalars(select(Phone).where(Phone.prospect_id == jean.id)).all()
    assert {(p.number, p.is_primary, p.origin_type) for p in phones} == {
        ("+33100000001", False, OriginType.IMPORTED),
        ("+33600000001", True, OriginType.IMPORTED),
    }
    source = db_session.scalars(
        select(ProspectSource).where(ProspectSource.prospect_id == jean.id)
    ).one()
    assert (source.import_batch_id, source.source_reference) == (batch.id, reference)
    assert source.legal_basis_or_collection_context == LEGAL_BASIS
    assert (source.actor_type, source.actor_id) == (ActorType.IMPORT, str(batch.id))
    company = db_session.get(Company, jean.company_id)
    assert company is not None and company.display_name == "Transports Exemple SARL"
    assert [category.id for category in company.activity_categories] == [ids["road"]]
    assert (company.project_done_with_circoe, company.project_type) == ("Oui", "1 Étude fictive")
    assert company.email_domain == "example.com"  # first non-webmail domain of the rows
    # One company for the two spellings of the same key (rows 2 and 3).
    assert person(db_session, "Marc", "Démo").company_id == company.id
    assert count(db_session, ImportRowMetadata) == batch.rows_imported
    assert count(db_session, ProspectSource, ProspectSource.import_batch_id == batch.id) == 8


def test_defaults_apply_only_exact_matches_and_never_invent(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)

    commit(db_session, file, review, rows=excluded(10))

    jean = person(db_session, "Jean", "Test")
    jean_tracking = tracking(db_session, jean)
    assert jean_tracking is not None
    assert jean_tracking.referent_id == ids["claire"]  # exact referent
    assert jean_tracking.planned_contact_at is None  # `S37`: never a guessed year
    assert jean_tracking.status is ContactTrackingStatus.TO_CONTACT
    nina = person(db_session, "Nina", "Homonyme")  # homonym of a blocked person: a warning only
    assert nina.contactability_status is ContactabilityStatus.CONTACTABLE
    assert nina.role_id is None  # the inactive `Chef de quai` is not applied by default
    assert tracking(db_session, nina) is None  # partial referent `Paul`: to confirm, not applied
    assert person(db_session, "Léa", "Modèle").civility is None  # `0`
    claire = person(db_session, "Claire", "Exemple")
    assert claire.activity_status is ActivityStatus.UNKNOWN  # `retraité` only suggests it
    messagerie = db_session.get(Company, claire.company_id)
    assert messagerie is not None and messagerie.commercial_segment_id is None
    assert messagerie.activity_categories == []
    assert person(db_session, "Marc", "Démo").role_id is None  # unknown role left unclassified
    assert count(db_session, Role) == 3 and count(db_session, ActivityCategory) == 2


def test_historical_stages_and_address_become_tracking_and_establishment(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)

    commit(db_session, file, review, rows=excluded(10))

    hugo_tracking = tracking(db_session, person(db_session, "Hugo", "Fictif"))
    assert hugo_tracking is not None and hugo_tracking.status is ContactTrackingStatus.QUOTE_SENT
    assert [h.to_status for h in hugo_tracking.status_history] == [ContactTrackingStatus.QUOTE_SENT]
    assert hugo_tracking.status_history[0].actor_type is ActorType.IMPORT
    emma = person(db_session, "Emma", "Test")
    emma_tracking = tracking(db_session, emma)
    assert emma_tracking is not None
    assert emma_tracking.status is ContactTrackingStatus.APPOINTMENT_OBTAINED
    site = db_session.scalars(
        select(Establishment).where(Establishment.company_id == emma.company_id)
    ).one()
    assert (site.address_line1, site.postal_code, site.city, site.is_primary) == (
        "12 rue de l'Exemple",
        "69000",
        "Lyon",
        True,
    )


def test_every_row_is_created_linked_or_excluded(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)

    result = commit(
        db_session,
        file,
        review,
        rows={10: resolution("exclude"), 9: resolution("attach", prospect_id=str(ids["blocked"]))},
    )

    traced = {row.source_row_number for row in db_session.scalars(select(ImportRowMetadata))}
    assert traced == set(range(2, 12)) - {10}
    assert result.batch.rows_imported + result.batch.rows_skipped == result.batch.rows_total
    assert result.counts["prospects_attached"] == 1


# --- validation ----------------------------------------------------------------------------------


def test_rows_in_error_must_be_resolved_or_excluded(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)

    errors = refused(db_session, file, review, rows={9: resolution("create")})

    assert errors == {
        (DecisionErrorCode.MISSING_NAME, 10),
        (DecisionErrorCode.BLOCKED_BY_DO_NOT_CONTACT, 9),
    }
    assert count(db_session, ImportBatch) == 0


def test_a_correction_is_reviewed_again_and_keeps_the_original(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    options = PreviewOptions.model_validate(
        {
            "corrections": {
                10: {"first_name": "Zoé", "last_name": "Correctif"},
                6: {"email": "paul.essai@example.com"},
            }
        }
    )
    review = review_of(db_session, file, options)
    assert review.preview.rows[8].status.value != "error"

    commit(db_session, file, review, corrections=options.corrections)

    zoe = person(db_session, "Zoé", "Correctif")
    paul = person(db_session, "Paul", "Essai")
    assert [email.address for email in paul.emails] == ["paul.essai@example.com"]
    kept = trace(db_session, 6).legacy_metadata["email_original"]
    assert kept == {
        "column": "O",
        "header": "Mail",
        "value": "paul.essai@",
        "reason": LegacyReason.CORRECTED.value,
    }
    assert zoe.company_id == person(db_session, "Jean", "Test").company_id


def test_an_uncorrectable_field_is_refused_by_the_engine(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    options = PreviewOptions.model_validate({"corrections": {2: {"referent": "Claire"}}})

    with pytest.raises(ImportRejectedError) as caught:
        review_of(db_session, upload(), options)

    assert caught.value.code is DiagnosticCode.MAPPING_UNCORRECTABLE_FIELD


# --- grouped mappings ---------------------------------------------------------------------------


def people(*titles: str) -> list[Row]:
    return [
        {**PERSON, "first_name": f"Prénom{index}", "job": title}
        for index, title in enumerate(titles, start=1)
    ]


def test_a_role_mapping_applies_to_every_row_of_the_group(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload(people("Directeur fictif", "DIRECTEUR FICTIF", "Directeur  fictif"))
    review = review_of(db_session, file)
    assert [(g.text, g.rows, g.status.value) for g in review.roles] == [
        ("Directeur fictif", [2, 3, 4], "unmatched")
    ]

    commit(
        db_session,
        file,
        review,
        roles={review.roles[0].key: {"action": "existing", "role_id": str(ids["dirigeant"])}},
    )

    titles = db_session.scalars(select(Prospect.exact_job_title).order_by(Prospect.first_name))
    roles = db_session.scalars(
        select(Prospect.role_id).where(Prospect.last_name == "Essai").order_by(Prospect.first_name)
    ).all()
    assert roles == [ids["dirigeant"]] * 3
    assert "DIRECTEUR FICTIF" in list(titles)  # the exact title is kept as typed


def test_an_explicitly_created_role_is_audited_as_the_user(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload(people("Directeur fictif", "Directeur fictif"))
    review = review_of(db_session, file)
    decision = {"action": "create", "label": "Directeur des opérations"}

    result = commit(db_session, file, review, roles={review.roles[0].key: decision})

    role = db_session.scalars(select(Role).where(Role.label == "Directeur des opérations")).one()
    assert {
        p.role_id for p in db_session.scalars(select(Prospect).where(Prospect.last_name == "Essai"))
    } == {role.id}
    [event] = audit_events(db_session, action="role.created")
    assert (event.actor_type, event.actor_id, event.context["source"]) == (
        ActorType.HUMAN,
        OPERATOR.id,
        "ui",
    )
    assert result.counts["roles_created"] == 1


def test_a_role_to_create_that_already_exists_is_refused(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload(people("Directeur fictif"))
    review = review_of(db_session, file)

    with pytest.raises(DuplicateValueError):
        commit(
            db_session,
            file,
            review,
            roles={review.roles[0].key: {"action": "create", "label": " dirigeant "}},
        )

    assert count(db_session, ImportBatch) == 0


def test_category_tokens_map_to_categories_a_new_category_or_the_segment(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)
    unmatched = key_of(review, "categories", "Logistique & Stockage")
    segment = key_of(review, "categories", "Transporteur")

    result = commit(
        db_session,
        file,
        review,
        rows=excluded(10),
        categories={
            unmatched: {"action": "create", "label": "Logistique fictive"},
            segment: {"action": "segment", "segment_id": str(ids["carrier"])},
        },
    )

    company = db_session.scalars(
        select(Company).where(Company.display_name == "Messagerie Fictive")
    ).one()
    assert [c.label for c in company.activity_categories] == ["Logistique fictive"]
    assert company.commercial_segment_id == ids["carrier"]
    assert result.counts["categories_created"] == 1


def test_referent_civility_week_and_inactive_decisions(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)

    commit(
        db_session,
        file,
        review,
        rows={10: resolution("exclude"), 4: {"inactive": True}},
        referents={
            key_of(review, "referents", "Paul"): {
                "action": "existing",
                "referent_id": str(ids["paul"]),
            }
        },
        civilities={key_of(review, "civilities", "0"): "ms"},
        week_year=2026,
        weeks={"39": None},
    )

    nina_tracking = tracking(db_session, person(db_session, "Nina", "Homonyme"))
    assert nina_tracking is not None and nina_tracking.referent_id == ids["paul"]
    assert person(db_session, "Léa", "Modèle").civility is Civility.MS
    assert person(db_session, "Claire", "Exemple").activity_status is ActivityStatus.INACTIVE
    jean_tracking = tracking(db_session, person(db_session, "Jean", "Test"))
    assert jean_tracking is not None
    assert jean_tracking.planned_contact_at == datetime(2026, 9, 7, tzinfo=PARIS)  # S37 2026
    marc_tracking = tracking(db_session, person(db_session, "Marc", "Démo"))
    assert marc_tracking is None  # S39 left without year, `xxx` is not a referent


def test_week_53_needs_a_year_that_has_one(db_session: Session, ids: dict[str, uuid.UUID]) -> None:
    file = upload([{**PERSON, "first_name": "Iso", "week": "S53"}])
    review = review_of(db_session, file)

    assert refused(db_session, file, review, week_year=2025) == {
        (DecisionErrorCode.INVALID_WEEK_YEAR, None)
    }
    commit(db_session, file, review, week_year=2026)

    iso = tracking(db_session, person(db_session, "Iso", "Essai"))
    assert iso is not None and iso.planned_contact_at == datetime(2026, 12, 28, tzinfo=PARIS)


def test_unknown_keys_and_values_are_refused(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)

    errors = refused(
        db_session,
        file,
        review,
        rows={
            **excluded(10),
            99: resolution("exclude"),
            4: {"inactive": False},
            2: {"inactive": True},
        },
        roles={"inconnu": {"action": "none"}},
        referents={
            key_of(review, "referents", "Paul"): {
                "action": "existing",
                "referent_id": str(uuid.uuid4()),
            }
        },
    )

    assert errors == {
        (DecisionErrorCode.UNKNOWN_ROW, 99),
        (DecisionErrorCode.UNKNOWN_KEY, None),
        (DecisionErrorCode.UNKNOWN_VALUE, None),
        (DecisionErrorCode.INACTIVE_NOT_SUGGESTED, 2),
    }


# --- duplicates and contactability --------------------------------------------------------------

LUC_AGAIN: Row = {
    "company": "LOGISTIQUE DÉMO",
    "civility": "M.",
    "last_name": "Exemple",
    "first_name": "Luc",
    "job": "Responsable transport",
    "email": "l.exemple@logistique-demo.example / luc.exemple@example.com",
    "mobile": "06 00 00 00 09",
    "week": "S40 2026",
    "project_type": "Étude fictive",
}


def test_attaching_to_an_existing_prospect_fills_empty_fields_only(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    luc = db_session.get(Prospect, ids["luc"])
    assert luc is not None
    luc.exact_job_title = "Chef d'équipe fictif"
    db_session.flush()
    file = upload([LUC_AGAIN])
    review = review_of(db_session, file)
    assert review.rows[0].default_resolution.action == "attach"
    assert review.companies[0].default.action == "link"

    result = commit(db_session, file, review)

    db_session.refresh(luc)
    assert luc.civility is Civility.MR and luc.role_id == ids["transport"]  # were empty
    assert luc.exact_job_title == "Chef d'équipe fictif"  # never overwritten…
    assert trace(db_session, 2).legacy_metadata["job_title"]["value"] == "Responsable transport"
    emails = {e.address: e for e in luc.emails}
    assert emails["luc.exemple@example.com"].verification_status is VerificationStatus.VERIFIED
    added = emails["l.exemple@logistique-demo.example"]
    assert (added.is_primary, added.origin_type, added.verification_status) == (
        False,
        OriginType.IMPORTED,
        VerificationStatus.UNVERIFIED,
    )
    assert {p.number: p.is_primary for p in luc.phones} == {
        "+33100000009": True,
        "+33600000009": False,
    }
    demo = db_session.get(Company, ids["demo"])
    assert demo is not None and demo.email_domain == "logistique-demo.example"  # was empty
    assert demo.project_type == "Étude fictive"
    luc_tracking = tracking(db_session, luc)
    assert luc_tracking is not None
    assert luc_tracking.planned_contact_at == datetime(2026, 9, 28, tzinfo=PARIS)
    assert count(db_session, Prospect) == 3 and count(db_session, Company) == 1
    assert result.counts["prospects_attached"] == 1 and result.counts["companies_linked"] == 1
    assert trace(db_session, 2).prospect_id == luc.id


def test_duplicates_can_be_created_merged_into_another_row_or_excluded(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    twin = {**PERSON, "first_name": "Jumeau", "email": "jumeau@example.com"}
    file = upload(
        [twin, {**twin, "email": "jumeau.bis@example.com", "phone": "01 00 00 00 07"}, twin]
    )
    review = review_of(db_session, file)
    assert [row.default_resolution.action for row in review.rows] == [
        "create",
        "attach_row",
        "attach_row",
    ]

    result = commit(db_session, file, review, rows={4: resolution("exclude")})

    twin_prospect = person(db_session, "Jumeau", "Essai")
    assert sorted(e.address for e in twin_prospect.emails) == [
        "jumeau.bis@example.com",
        "jumeau@example.com",
    ]
    assert [p.number for p in twin_prospect.phones] == ["+33100000007"]
    assert trace(db_session, 3).prospect_id == twin_prospect.id
    assert result.counts["rows_merged"] == 1 and result.batch.rows_skipped == 1
    # Created as a separate person on request.
    file_2 = upload([twin, twin], filename="autre.xlsx")
    review_2 = review_of(db_session, file_2)
    commit(db_session, file_2, review_2, rows={3: resolution("create")})
    # The first row now attaches to the prospect created above; the second is created apart.
    assert count(db_session, Prospect, Prospect.first_name == "Jumeau") == 2


def test_a_merge_needs_a_candidate_and_a_kept_target(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    twin = {**PERSON, "first_name": "Jumeau"}
    file = upload([twin, twin, {**PERSON, "first_name": "Autre"}])
    review = review_of(db_session, file)

    errors = refused(
        db_session,
        file,
        review,
        rows={
            2: resolution("exclude"),
            4: resolution("attach_row", row=2),
            5: resolution("attach", prospect_id=str(ids["luc"])),
        },
    )

    assert errors == {
        (DecisionErrorCode.ATTACHED_TO_EXCLUDED, 3),
        (DecisionErrorCode.NOT_A_CANDIDATE, 4),
        (DecisionErrorCode.UNKNOWN_ROW, 5),
    }


def test_a_do_not_contact_match_is_never_recreated_nor_reactivated(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    bruno = {**SAMPLE_ROWS[7], "phone": "01 00 00 00 05", "rdv": "oui", "week": "S37 2026"}
    file = upload([bruno])
    review = review_of(db_session, file)
    assert review.rows[0].default_resolution.action == "exclude"
    assert refused(db_session, file, review, rows={2: resolution("create")}) == {
        (DecisionErrorCode.BLOCKED_BY_DO_NOT_CONTACT, 2)
    }
    assert refused(
        db_session, file, review, rows={2: resolution("attach", prospect_id=str(ids["luc"]))}
    ) == {(DecisionErrorCode.NOT_A_CANDIDATE, 2)}

    result = commit(
        db_session, file, review, rows={2: resolution("attach", prospect_id=str(ids["blocked"]))}
    )

    blocked = db_session.get(Prospect, ids["blocked"])
    assert blocked is not None
    assert blocked.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert blocked.do_not_contact_reason == "Opposition fictive"
    assert [p.number for p in blocked.phones] == ["+33100000005"]
    assert tracking(db_session, blocked) is None  # nobody to contact
    kept = trace(db_session, 2).legacy_metadata
    assert {"stage_appointment", "planned_contact"} <= set(kept)
    assert count(db_session, Prospect, Prospect.last_name == "Bloqué") == 1
    assert result.counts["prospects_attached"] == 1
    assert not audit_events(db_session, action="prospect.do_not_contact.cleared")


# --- losslessness -------------------------------------------------------------------------------


def test_values_the_import_does_not_apply_stay_in_the_row_metadata(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)

    commit(
        db_session,
        file,
        review,
        rows=excluded(10),
        referents={key_of(review, "referents", "Claire Référente"): {"action": "ignore"}},
    )

    row_2 = trace(db_session, 2).legacy_metadata
    assert row_2["contact_mode"]["value"] == "Auto"  # opaque column
    assert row_2["legacy_to_contact_flag"]["value"] == "Oui"
    assert row_2["planned_contact"]["value"] == "S37"  # week without year
    assert row_2["referent"]["value"] == "Claire Référente"  # exact match the user left out
    row_3 = trace(db_session, 3).legacy_metadata
    assert row_3["company_name"]["value"] == "TRANSPORTS EXEMPLE"  # other spelling
    assert row_3["project_done_with_circoe"]["value"] == "Non"  # conflicts with row 2's value
    assert row_3["category"]["value"] == "Non"
    assert row_3["referent"]["value"] == "xxx"
    row_8 = trace(db_session, 8).legacy_metadata
    assert row_8["column_X"]["value"] == "note fictive"
    assert all("value" in value and "reason" in value for value in row_8.values())


def test_legacy_metadata_stays_out_of_the_audit_log(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)

    batch = commit(db_session, file, review, rows=excluded(10)).batch

    events = audit_events(db_session)
    assert not [e for e in events if e.entity_type == "import_row_metadata"]
    imported = [e for e in events if e.actor_type is ActorType.IMPORT]
    assert imported and all(e.context["import_batch_id"] == str(batch.id) for e in imported)
    assert all(e.context["on_behalf_of"]["id"] == OPERATOR.id for e in imported)
    assert {e.action for e in events if e.entity_type == "import_batch"} == {
        "import_batch.started",
        "import_batch.committed",
    }
    assert "Auto" not in str([e.changes for e in events])


# --- staleness, re-import, rollback -------------------------------------------------------------


def test_the_file_and_the_preview_must_be_the_reviewed_ones(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload()
    review = review_of(db_session, file)
    other = upload([*SAMPLE_ROWS, {**PERSON, "first_name": "Nouveau"}])

    with pytest.raises(import_commit.StalePreviewError) as caught:
        import_commit.commit_import(
            db_session, OPERATOR, other, decide(review, rows=excluded(10)), LIMITS
        )
    assert caught.value.code == "file_changed"

    add_company(db_session, "Entrepôts Test SARL")  # a new duplicate candidate appears
    with pytest.raises(import_commit.StalePreviewError) as caught:
        commit(db_session, file, review, rows=excluded(10))
    assert caught.value.code == "preview_outdated"
    assert count(db_session, ImportBatch) == 0


def test_a_committed_file_can_be_imported_again_only_knowingly(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    file = upload([{**PERSON, "first_name": "Unique"}])
    first = commit(db_session, file, review_of(db_session, file)).batch

    review, previous = import_commit.review_upload(db_session, file, PreviewOptions(), LIMITS)
    assert [batch.id for batch in previous] == [first.id]
    with pytest.raises(import_commit.ReimportNotAcknowledgedError):
        commit(db_session, file, review, rows={2: resolution("create")})

    commit(db_session, file, review, rows={2: resolution("create")}, acknowledge_reimport=True)
    assert count(db_session, ImportBatch, ImportBatch.status == ImportBatchStatus.COMMITTED) == 2


def test_a_failure_while_writing_leaves_no_partial_data(
    db_session: Session, ids: dict[str, uuid.UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    file = upload()
    review = review_of(db_session, file)
    before = {model: count(db_session, model) for model in (Prospect, Company, Email, Role)}
    calls = 0
    real = provenance.add_import_source

    def failing(*args: Any, **kwargs: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 4:
            raise RuntimeError("simulated failure")
        return real(*args, **kwargs)

    monkeypatch.setattr(provenance, "add_import_source", failing)
    roles = {review.roles[1].key: {"action": "create", "label": "Rôle éphémère"}}

    with pytest.raises(import_commit.ImportCommitFailedError) as caught:
        commit(db_session, file, review, rows=excluded(10), roles=roles)

    assert caught.value.row == 5 and caught.value.reason == "unexpected"
    after = {model: count(db_session, model) for model in (Prospect, Company, Email, Role)}
    assert after == before
    assert count(db_session, ImportRowMetadata) == 0 and count(db_session, ProspectSource) == 0
    assert not [e for e in audit_events(db_session) if e.actor_type is ActorType.IMPORT]
    [batch] = db_session.scalars(select(ImportBatch)).all()
    assert (batch.id, batch.status, batch.rows_imported) == (
        caught.value.batch_id,
        ImportBatchStatus.FAILED,
        0,
    )
    assert {e.action for e in audit_events(db_session, entity_type="import_batch")} == {
        "import_batch.started",
        "import_batch.failed",
    }


def test_the_review_groups_values_and_names_existing_candidates(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    review = review_of(db_session, upload([*SAMPLE_ROWS, LUC_AGAIN]))

    assert {g.text: g.status.value for g in review.referents} == {
        "Claire Référente": "exact",
        "xxx": "marker",
        "?": "marker",
        "v": "marker",
        "contact.test@example.com": "email_like",
        "parti à la retraite en 2024": "note",
        "Paul": "partial",
    }
    assert [(g.key, g.rows) for g in review.weeks] == [("37", [2]), ("39", [3])]
    assert [(g.text, g.rows) for g in review.civilities] == [("0", [5])]
    fret = next(g for g in review.companies if g.key == "fret modele")
    assert (fret.variants, fret.rows) == (["Fret Modèle SAS", "Fret Modèle"], [5, 6])
    demo = next(g for g in review.companies if g.key == "logistique demo")
    assert demo.default.action == "link" and demo.rows == [9, 12]
    assert {p.id for p in review.prospects} == {ids["blocked"], ids["luc"], ids["homonym"]}
    luc = next(p for p in review.prospects if p.id == ids["luc"])
    assert (luc.company_name, luc.emails) == ("Logistique Démo SAS", ["luc.exemple@example.com"])
    assert review.rows[2].inactive_suggested and not review.rows[0].inactive_suggested
