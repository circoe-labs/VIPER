"""Cancelling a committed import: what it wrote goes, what was used since stays. Invented values."""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Company, ContactSequence, Email, Establishment, Prospect, ProspectSource
from app.models.enums import ImportBatchStatus
from app.services import import_cancel, prospects
from app.services.errors import BusinessRuleError
from tests.builders import OPERATOR
from tests.import_support import seed
from tests.test_import_commit import commit, review_of, upload

IMPORTS = "/api/imports"


@pytest.fixture
def ids(db_session: Session) -> dict[str, uuid.UUID]:
    return seed(db_session)


def snapshot(session: Session) -> dict[str, object]:
    """The CRM rows an import writes, comparable before and after."""
    session.expire_all()
    people = session.execute(
        select(
            Prospect.id,
            Prospect.company_id,
            Prospect.first_name,
            Prospect.last_name,
            Prospect.exact_job_title,
            Prospect.civility,
            Prospect.role_id,
            Prospect.activity_status,
            Prospect.employment_verified_at,
        ).order_by(Prospect.id)
    ).all()
    firms = session.execute(
        select(
            Company.id, Company.display_name, Company.email_domain, Company.client_approach
        ).order_by(Company.id)
    ).all()
    counted = {
        model.__name__: session.scalar(select(func.count()).select_from(model))
        for model in (Email, Establishment, ContactSequence, ProspectSource)
    }
    return {"people": people, "companies": firms, **counted}


def imported(session: Session) -> uuid.UUID:
    file = upload()
    return commit(session, file, review_of(session, file)).batch.id


def test_cancelling_gives_back_the_base_as_it_was(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    before = snapshot(db_session)
    batch_id = imported(db_session)
    assert snapshot(db_session) != before

    announced = import_cancel.preview(db_session, OPERATOR, batch_id)
    done = import_cancel.cancel(db_session, OPERATOR, batch_id)

    assert announced == done
    assert done.prospects_deleted == 8 and done.prospects_kept == 0
    assert done.companies_deleted > 0 and done.companies_kept == 0
    assert snapshot(db_session) == before


def test_the_preview_writes_nothing(db_session: Session, ids: dict[str, uuid.UUID]) -> None:
    batch_id = imported(db_session)
    after = snapshot(db_session)

    import_cancel.preview(db_session, OPERATOR, batch_id)

    assert snapshot(db_session) == after


def test_a_prospect_used_since_is_kept_with_its_company(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    batch_id = imported(db_session)
    hugo = db_session.scalars(select(Prospect).where(Prospect.first_name == "Hugo")).one()
    prospects.mark_do_not_contact(db_session, OPERATOR, hugo.id, reason="Opposition fictive")

    done = import_cancel.cancel(db_session, OPERATOR, batch_id)

    assert (done.prospects_deleted, done.prospects_kept, done.companies_kept) == (7, 1, 1)
    assert db_session.get(Prospect, hugo.id) is not None
    assert db_session.get(Company, hugo.company_id) is not None


def test_only_a_committed_import_can_be_cancelled_once(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    batch_id = imported(db_session)
    import_cancel.cancel(db_session, OPERATOR, batch_id)

    with pytest.raises(BusinessRuleError, match="committed"):
        import_cancel.cancel(db_session, OPERATOR, batch_id)


def test_the_file_can_be_imported_again_after_a_cancellation(
    db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    import_cancel.cancel(db_session, OPERATOR, imported(db_session))

    assert imported(db_session)


def test_the_api_previews_then_cancels(
    client: TestClient, db_session: Session, ids: dict[str, uuid.UUID]
) -> None:
    batch_id = imported(db_session)

    announced = client.get(f"{IMPORTS}/{batch_id}/cancellation")
    done = client.post(f"{IMPORTS}/{batch_id}/cancel")

    assert announced.status_code == 200, announced.text
    assert done.status_code == 200, done.text
    assert announced.json() == done.json()
    assert client.get(f"{IMPORTS}/{batch_id}").json()["status"] == ImportBatchStatus.CANCELLED
    assert client.post(f"{IMPORTS}/{batch_id}/cancel").status_code == 409
