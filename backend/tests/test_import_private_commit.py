"""Private end-to-end check of the Task 09 review + commit on the real, git-ignored workbook.

Skipped unless `VIPER_PRIVATE_WORKBOOK` points to the file; never runs in CI. The commit happens
inside the test database's rolled-back transaction, so no real row survives the test. Privacy: only
counts, codes and invariants are asserted or printed — never a value.
Run from `backend/`:
`VIPER_PRIVATE_WORKBOOK=<path> pytest tests/test_import_private_commit.py -m private -s`.
"""

import os
from collections import Counter
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Company,
    ContactTracking,
    Email,
    ImportRowMetadata,
    Phone,
    Prospect,
    ProspectSource,
)
from app.models.enums import ContactabilityStatus, OriginType, VerificationStatus
from app.seed import seed_taxonomies
from app.services import import_commit
from app.services.imports.decisions import ImportDecisions, PreviewOptions
from app.services.imports.preview import ImportFile
from app.services.imports.workbook import ImportLimits
from tests.builders import OPERATOR, bind_operator

WORKBOOK = os.environ.get("VIPER_PRIVATE_WORKBOOK", "")

pytestmark = [
    pytest.mark.private,
    pytest.mark.skipif(
        not WORKBOOK or not Path(WORKBOOK).is_file(),
        reason="VIPER_PRIVATE_WORKBOOK does not point to the private workbook",
    ),
]


def count(session: Session, model: type[Any], *where: Any) -> int:
    return session.scalar(select(func.count()).select_from(model).where(*where)) or 0


def test_the_real_workbook_commits_with_the_default_decisions(db_session: Session) -> None:
    seed_taxonomies(db_session)
    bind_operator(db_session)
    path = Path(WORKBOOK)
    file = ImportFile(path.name, path.read_bytes())
    review, _ = import_commit.review_upload(db_session, file, PreviewOptions(), ImportLimits())
    missing_name = [
        row.row_number
        for row in review.preview.rows
        if any(item.code.value == "prospect.missing_name" for item in row.diagnostics)
    ]
    decisions = ImportDecisions.model_validate(
        {
            "file_fingerprint": review.preview.summary.file_fingerprint,
            "preview_digest": review.digest,
            "legal_basis_or_collection_context": "Fichier historique Circoe — prospection B2B",
            "rows": {number: {"resolution": {"action": "exclude"}} for number in missing_name},
        }
    )
    blocked_before = count(
        db_session,
        Prospect,
        Prospect.contactability_status == ContactabilityStatus.DO_NOT_CONTACT,
    )

    result = import_commit.commit_import(db_session, OPERATOR, file, decisions, ImportLimits())

    batch = result.batch
    excluded = set(missing_name) | {
        row.row_number for row in review.rows if row.default_resolution.action == "exclude"
    }
    traced = set(db_session.scalars(select(ImportRowMetadata.source_row_number)))
    assert traced | excluded == {row.row_number for row in review.preview.rows}
    assert not traced & excluded
    assert len(traced) == batch.rows_imported == count(db_session, ProspectSource)
    assert batch.rows_imported + batch.rows_skipped == batch.rows_total
    assert blocked_before == count(
        db_session,
        Prospect,
        Prospect.contactability_status == ContactabilityStatus.DO_NOT_CONTACT,
    )
    assert count(db_session, Email, Email.origin_type != OriginType.IMPORTED) == 0
    assert count(db_session, Email, Email.verification_status != VerificationStatus.UNVERIFIED) == 0
    assert count(db_session, Prospect, Prospect.employment_verified_at.is_not(None)) == 0
    groups = {
        name: dict(Counter(group.status.value for group in getattr(review, name)))
        for name in ("roles", "categories", "referents")
    }
    print(
        "\nrows",
        review.preview.summary.rows_by_status,
        "\ngroups",
        groups,
        "weeks",
        len(review.weeks),
        "civilities",
        len(review.civilities),
        "companies",
        len(review.companies),
        "\ndefaults",
        dict(Counter(row.default_resolution.action for row in review.rows)),
        "\ncounts",
        dict(sorted(result.counts.items())),
        "\ntables",
        {
            model.__tablename__: count(db_session, model)
            for model in (Company, Prospect, Email, Phone, ContactTracking, ImportRowMetadata)
        },
    )
