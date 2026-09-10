"""Seed suggested taxonomy values. Run from `backend/`: `python -m app.seed [--db test]`.

Seeds are editable suggestions, not product truth. Idempotent: a value whose slug or label already
exists is skipped and existing rows are never touched. No companies, prospects or referents.
"""

import argparse

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import create_db_engine, create_session_factory, unit_of_work
from app.models.taxonomies import ActivityCategory, CommercialSegment, Role
from app.repositories import taxonomies
from app.repositories.taxonomies import TaxonomyModel

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
    return {
        model.__tablename__: taxonomies.insert_missing(session, model, values)
        for model, values in SUGGESTIONS.items()
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", choices=("dev", "test"), default="dev", help="target database")
    args = parser.parse_args(argv)
    settings = get_settings()
    engine = create_db_engine(
        settings.test_database_url if args.db == "test" else settings.database_url
    )
    try:
        with unit_of_work(create_session_factory(engine)) as session:
            inserted = seed_taxonomies(session)
    finally:
        engine.dispose()
    for table, count in inserted.items():
        print(f"{table}: {count} inserted")


if __name__ == "__main__":
    main()
