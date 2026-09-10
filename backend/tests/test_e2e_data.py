"""The Playwright data loader: attributed writes only, and never outside an `*_e2e` database."""

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models import AuditLogEntry
from app.services.audit import UnattributedMutationError
from tests import e2e_data
from tests.fixtures.synthetic.explorer_dataset import PROSPECT_COUNT, seed_explorer_dataset


def test_refuses_a_database_not_named_e2e(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("VIPER_DATABASE_URL", "postgresql+psycopg://viper:viper@127.0.0.1:1/viper")

    assert e2e_data.main() == 1
    assert "must end with '_e2e'" in capsys.readouterr().out


def test_the_dataset_is_audited_as_created_by_the_bound_actor(db_session: Session) -> None:
    seed_explorer_dataset(db_session)

    created = db_session.scalar(
        select(func.count())
        .select_from(AuditLogEntry)
        .where(AuditLogEntry.entity_type == "prospect", AuditLogEntry.actor_id == "tests.fixtures")
    )
    assert created == PROSPECT_COUNT


def test_the_dataset_cannot_be_loaded_without_an_actor(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session, pytest.raises(UnattributedMutationError):
        seed_explorer_dataset(session)
