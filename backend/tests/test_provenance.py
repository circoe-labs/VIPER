"""Provenance (prospect sources) and the import batch lifecycle, with their audit trail."""

import uuid
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorType
from app.db.session import unit_of_work
from app.models import ImportRowMetadata, Prospect
from app.models.enums import ImportBatchStatus, ProspectSourceType
from app.services import import_batches, provenance
from app.services.errors import DomainError, NotFoundError
from tests.builders import OPERATOR, add_prospect, audit_events, bind_operator

FINGERPRINT = "a" * 64
LEGAL_CONTEXT = "Intérêt légitime — prospection B2B (synthétique)"


def test_manual_provenance_records_source_date_context_and_actor(db_session: Session) -> None:
    prospect = add_prospect(db_session)

    source = provenance.add_manual_source(
        db_session,
        OPERATOR,
        prospect.id,
        legal_basis_or_collection_context=f"  {LEGAL_CONTEXT} ",
        notes="Rencontré sur un salon (synthétique)",
    )

    assert source.source_type is ProspectSourceType.MANUAL
    assert source.collected_at is not None
    assert source.legal_basis_or_collection_context == LEGAL_CONTEXT
    assert (source.actor_type, source.actor_id, source.actor_display) == (
        OPERATOR.type,
        OPERATOR.id,
        OPERATOR.display,
    )
    [event] = audit_events(db_session)
    assert (event.action, event.entity_id) == ("prospect_source.created", source.id)
    assert (event.subject_type, event.subject_id) == ("prospect", prospect.id)
    assert event.changes["source_type"] == {"before": None, "after": "manual"}


def test_sources_are_listed_oldest_first(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    later = provenance.add_manual_source(db_session, OPERATOR, prospect.id)
    earlier = provenance.add_source(
        db_session,
        OPERATOR,
        prospect.id,
        ProspectSourceType.OTHER,
        source_reference="https://annuaire.example/entreprise",
        collected_at=datetime(2025, 1, 15, 9, 0, tzinfo=UTC),
    )
    provenance.add_manual_source(db_session, OPERATOR, add_prospect(db_session).id)

    assert provenance.list_sources(db_session, prospect.id) == [earlier, later]


def test_invalid_sources_are_refused(db_session: Session) -> None:
    prospect = add_prospect(db_session)

    with pytest.raises(DomainError, match="import batch"):
        provenance.add_source(db_session, OPERATOR, prospect.id, ProspectSourceType.EXCEL_IMPORT)
    with pytest.raises(DomainError, match="import batch"):
        provenance.add_source(
            db_session,
            OPERATOR,
            prospect.id,
            ProspectSourceType.MANUAL,
            import_batch_id=uuid.uuid4(),
        )
    with pytest.raises(DomainError, match="time zone"):
        provenance.add_source(
            db_session,
            OPERATOR,
            prospect.id,
            ProspectSourceType.OTHER,
            collected_at=datetime(2025, 1, 15, 9, 0),
        )
    with pytest.raises(NotFoundError):
        provenance.add_manual_source(db_session, OPERATOR, uuid.uuid4())
    assert provenance.list_sources(db_session, prospect.id) == []


def test_an_import_is_traced_from_batch_to_rows_with_the_import_actor(
    db_session: Session,
) -> None:
    bind_operator(db_session)
    batch = import_batches.start_batch(
        db_session,
        OPERATOR,
        filename=" prospects-exemple.xlsx ",
        sheet_names=["Prospects"],
        file_fingerprint=FINGERPRINT,
    )

    with import_batches.importing(db_session, batch, confirmed_by=OPERATOR) as importer:
        prospect = Prospect(first_name="Jean", last_name="Import")
        db_session.add(prospect)
        db_session.flush()
        source = provenance.add_import_source(
            db_session, importer, prospect.id, batch, sheet="Prospects", row_number=2
        )
        row = import_batches.record_row(
            db_session,
            batch,
            sheet="Prospects",
            row_number=2,
            prospect_id=prospect.id,
            legacy_metadata={"Mode de contact": "Commerciale", "Relance": date(2025, 3, 3)},
        )
    import_batches.finish_batch(
        db_session,
        OPERATOR,
        batch,
        ImportBatchStatus.COMMITTED,
        rows_total=3,
        rows_imported=1,
        rows_skipped=2,
    )

    assert (batch.status, batch.actor_type, batch.actor_display) == (
        ImportBatchStatus.COMMITTED,
        ActorType.HUMAN,
        OPERATOR.display,
    )
    assert batch.committed_at is not None
    assert source.source_reference == "prospects-exemple.xlsx / Prospects / ligne 2"
    assert source.import_batch_id == batch.id
    assert row.legacy_metadata == {"Mode de contact": "Commerciale", "Relance": "2025-03-03"}

    started, created, sourced, committed = audit_events(db_session)
    assert [started.action, created.action, sourced.action, committed.action] == [
        "import_batch.started",
        "prospect.created",
        "prospect_source.created",
        "import_batch.committed",
    ]
    assert started.changes["filename"] == {"before": None, "after": "prospects-exemple.xlsx"}
    assert started.changes["sheet_names"] == {"before": None, "after": ["Prospects"]}
    assert started.changes["status"] == {"before": None, "after": "pending"}
    for entry in (started, committed):
        assert (entry.actor_type, entry.actor_id) == (ActorType.HUMAN, OPERATOR.id)
        assert (entry.subject_type, entry.subject_id) == ("import_batch", batch.id)
    for entry in (created, sourced):
        assert (entry.actor_type, entry.actor_id, entry.actor_display) == (
            ActorType.IMPORT,
            str(batch.id),
            "Import prospects-exemple.xlsx",
        )
        assert entry.context == {
            "source": "import",
            "request_id": "test-request",
            "import_batch_id": str(batch.id),
            "on_behalf_of": {"type": "human", "id": OPERATOR.id, "display": OPERATOR.display},
        }
    assert committed.changes["status"] == {"before": "pending", "after": "committed"}
    assert committed.changes["rows_imported"] == {"before": 0, "after": 1}
    assert committed.changes["rows_skipped"] == {"before": 0, "after": 2}
    # Raw legacy values stay in import_row_metadata only.
    stored = str([(entry.changes, entry.context) for entry in audit_events(db_session)])
    assert "Commerciale" not in stored


def test_a_failed_import_is_recorded_after_its_rollback(
    session_factory: sessionmaker[Session],
) -> None:
    with unit_of_work(session_factory) as session:
        batch_id = import_batches.start_batch(
            session, OPERATOR, filename="echec.xlsx", sheet_names=["Prospects"]
        ).id

    with pytest.raises(RuntimeError), unit_of_work(session_factory) as session:
        batch = import_batches.get_batch(session, batch_id)
        with import_batches.importing(session, batch, confirmed_by=OPERATOR):
            session.add(Prospect(first_name="Annulé"))
            session.flush()
            raise RuntimeError("row 3 cannot be imported")

    with unit_of_work(session_factory) as session:
        batch = import_batches.get_batch(session, batch_id)
        import_batches.finish_batch(
            session,
            OPERATOR,
            batch,
            ImportBatchStatus.FAILED,
            rows_total=3,
            rows_imported=0,
            rows_skipped=0,
        )

    with session_factory() as session:
        assert [event.action for event in audit_events(session)] == [
            "import_batch.started",
            "import_batch.failed",
        ]
        assert session.execute(select(Prospect)).first() is None
        assert import_batches.get_batch(session, batch_id).committed_at is None


@pytest.mark.parametrize("status", [ImportBatchStatus.CANCELLED, ImportBatchStatus.FAILED])
def test_a_batch_finishes_only_once_and_only_with_a_final_status(
    db_session: Session, status: ImportBatchStatus
) -> None:
    batch = import_batches.start_batch(db_session, OPERATOR, filename="annule.xlsx", sheet_names=[])
    counts = {"rows_total": 0, "rows_imported": 0, "rows_skipped": 0}

    with pytest.raises(DomainError, match="cannot finish"):
        import_batches.finish_batch(
            db_session, OPERATOR, batch, ImportBatchStatus.PENDING, **counts
        )
    import_batches.finish_batch(db_session, OPERATOR, batch, status, **counts)
    with pytest.raises(DomainError, match="already"):
        import_batches.finish_batch(
            db_session, OPERATOR, batch, ImportBatchStatus.COMMITTED, **counts
        )

    assert [event.action for event in audit_events(db_session)] == [
        "import_batch.started",
        f"import_batch.{status}",
    ]
    assert batch.committed_at is None


def test_import_batches_require_a_file_name_and_rows_a_known_batch(db_session: Session) -> None:
    with pytest.raises(DomainError, match="file name"):
        import_batches.start_batch(db_session, OPERATOR, filename="  ", sheet_names=[])
    with pytest.raises(NotFoundError):
        import_batches.get_batch(db_session, uuid.uuid4())
    assert db_session.execute(select(ImportRowMetadata)).first() is None
