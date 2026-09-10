"""Seed suggested taxonomy values. Run from `backend/`: `python -m app.seed [--db test]`.

Seeds are editable suggestions, not product truth. Idempotent: a value whose slug or label already
exists is skipped and existing rows are never touched. No companies, prospects or referents. Each
inserted value is audited as `<taxonomy>.created` by the system actor below.
"""

import argparse

from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.core.config import get_settings
from app.db.session import create_db_engine, create_session_factory
from app.models.taxonomies import ActivityCategory, CommercialSegment, Role
from app.repositories import taxonomies
from app.repositories.taxonomies import TaxonomyModel
from app.services import audit
from app.services.audit_changes import diff

SEED_ACTOR = ActorContext(type=ActorType.SYSTEM, display="Suggestions VIPER", id="app.seed")

SUGGESTIONS: dict[TaxonomyModel, tuple[tuple[str, str], ...]] = {
    Role: (
        ("dirigeant", "Dirigeant"),
        ("responsable-logistique", "Responsable logistique"),
        ("responsable-exploitation", "Responsable d'exploitation"),
        ("responsable-transport", "Responsable transport"),
    ),
    CommercialSegment: (
        ("transporteur", "Transporteur"),
        ("logisticien", "Logisticien"),
        ("chargeur", "Chargeur"),
    ),
    ActivityCategory: (
        ("transport-routier-marchandises", "Transport routier de marchandises"),
        ("entreposage-stockage", "Entreposage et stockage"),
        ("messagerie-fret-express", "Messagerie et fret express"),
        ("affretement-commission-transport", "Affrètement et commission de transport"),
    ),
}


def seed_taxonomies(session: Session) -> dict[str, int]:
    """Insert missing suggestions; returns inserted counts per table. The caller commits."""
    inserted: dict[str, int] = {}
    for model, values in SUGGESTIONS.items():
        rows = taxonomies.insert_missing(session, model, values)
        entity_type = audit.AUDITED_ENTITIES[model].entity_type
        for row_id, slug, label in rows:
            audit.record_event(
                session,
                SEED_ACTOR,
                audit.lifecycle_action(entity_type, audit.Lifecycle.CREATED),
                entity_type=entity_type,
                entity_id=row_id,
                changes=diff({}, {"slug": slug, "label": label}),
            )
        inserted[model.__tablename__] = len(rows)
    return inserted


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", choices=("dev", "test"), default="dev", help="target database")
    args = parser.parse_args(argv)
    settings = get_settings()
    engine = create_db_engine(
        settings.test_database_url if args.db == "test" else settings.database_url
    )
    try:
        with audit.attributed_unit_of_work(create_session_factory(engine), SEED_ACTOR) as session:
            inserted = seed_taxonomies(session)
    finally:
        engine.dispose()
    for table, count in inserted.items():
        print(f"{table}: {count} inserted")


if __name__ == "__main__":
    main()
