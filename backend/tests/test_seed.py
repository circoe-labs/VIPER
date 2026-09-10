"""Taxonomy seed: idempotent suggestions that never override user edits."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Role
from app.seed import SUGGESTIONS, seed_taxonomies
from tests.builders import add_role


def test_seed_is_idempotent(db_session: Session) -> None:
    first = seed_taxonomies(db_session)
    second = seed_taxonomies(db_session)

    assert first == {model.__tablename__: len(values) for model, values in SUGGESTIONS.items()}
    assert second == dict.fromkeys(first, 0)


def test_seed_never_overrides_or_duplicates_user_edits(db_session: Session) -> None:
    seed_taxonomies(db_session)
    leader = db_session.execute(select(Role).where(Role.slug == "dirigeant")).scalar_one()
    leader.label, leader.active = "Direction générale", False
    db_session.flush()

    assert seed_taxonomies(db_session)["roles"] == 0
    db_session.expire_all()
    assert (leader.label, leader.active) == ("Direction générale", False)


def test_seed_skips_a_label_already_created_under_another_slug(db_session: Session) -> None:
    add_role(db_session, "logistique", "responsable LOGISTIQUE")

    inserted = seed_taxonomies(db_session)

    assert inserted["roles"] == len(SUGGESTIONS[Role]) - 1
