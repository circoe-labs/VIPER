"""Taxonomy seed: idempotent suggestions that never override user edits."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models import Role
from app.seed import SUGGESTIONS, seed_taxonomies
from tests.builders import add_role, audit_events


def test_seed_is_idempotent(db_session: Session) -> None:
    first = seed_taxonomies(db_session)
    second = seed_taxonomies(db_session)

    assert first == {model.__tablename__: len(values) for model, values in SUGGESTIONS.items()}
    assert second == dict.fromkeys(first, 0)


def test_seeded_values_are_audited_by_the_system_actor(db_session: Session) -> None:
    seed_taxonomies(db_session)

    events = audit_events(db_session)
    assert len(events) == sum(len(values) for values in SUGGESTIONS.values())
    leader = db_session.execute(select(Role).where(Role.slug == "dirigeant")).scalar_one()
    [created] = [event for event in events if event.entity_id == leader.id]
    assert (created.action, created.actor_type, created.actor_display) == (
        "role.created",
        ActorType.SYSTEM,
        "Suggestions VIPER",
    )
    assert created.changes == {
        "label": {"before": None, "after": "Dirigeant"},
        "slug": {"before": None, "after": "dirigeant"},
    }
    assert created.context == {"source": "cli"}


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
