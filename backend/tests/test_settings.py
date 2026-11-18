"""Settings services: taxonomies (Task 06)."""

import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models import (
    ActivityCategory,
    CommercialSegment,
    Role,
)
from app.repositories import taxonomies as taxonomy_repository
from app.services import taxonomies
from app.services.errors import (
    DuplicateValueError,
    ExistingValue,
    InUseError,
    InvalidFieldError,
    NotFoundError,
)
from app.services.taxonomies import Taxonomy
from tests.builders import OPERATOR, add_company, add_prospect, add_role, audit_events

ROLE = Taxonomy.ROLE


def create_role(session: Session, label: str) -> taxonomies.TaxonomyValue:
    return taxonomies.create_value(session, OPERATOR, ROLE, label)


# --- taxonomies: create -----------------------------------------------------------------------


def test_created_value_is_active_normalized_slugged_and_audited(db_session: Session) -> None:
    value = create_role(db_session, "  Responsable   qualité ")

    assert (value.label, value.slug, value.active, value.usage_count) == (
        "Responsable qualité",
        "responsable-qualite",
        True,
        0,
    )
    [event] = audit_events(db_session)
    assert (event.action, event.entity_type, event.entity_id) == ("role.created", "role", value.id)
    assert (event.actor_type, event.actor_id, event.actor_display) == (
        ActorType.HUMAN,
        OPERATOR.id,
        OPERATOR.display,
    )
    assert event.changes == {
        "label": {"before": None, "after": "Responsable qualité"},
        "slug": {"before": None, "after": "responsable-qualite"},
        "active": {"before": None, "after": True},
    }


@pytest.mark.parametrize(
    ("existing", "attempt"),
    [
        ("Dirigeant", "DIRIGEANT"),
        ("Entrepôt frigorifique", "entrepot FRIGORIFIQUE"),
        ("Responsable transport", "  Responsable    transport "),
        ("Cœur de métier", "coeur de metier"),
    ],
)
def test_duplicates_are_refused_ignoring_case_accents_and_spacing(
    db_session: Session, existing: str, attempt: str
) -> None:
    original = create_role(db_session, existing)

    with pytest.raises(DuplicateValueError) as refused:
        create_role(db_session, attempt)

    assert refused.value.field == "label"
    assert refused.value.existing == ExistingValue(original.id, existing, True)


def test_an_inactive_value_still_blocks_its_duplicate_so_the_user_reactivates_it(
    db_session: Session,
) -> None:
    original = create_role(db_session, "Directeur des achats")
    taxonomies.set_value_active(db_session, OPERATOR, ROLE, original.id, False)

    with pytest.raises(DuplicateValueError) as refused:
        create_role(db_session, "directeur des achats")

    assert refused.value.existing == ExistingValue(original.id, "Directeur des achats", False)


def test_each_taxonomy_has_its_own_labels(db_session: Session) -> None:
    create_role(db_session, "Logistique")

    category = taxonomies.create_value(
        db_session, OPERATOR, Taxonomy.ACTIVITY_CATEGORY, "Logistique"
    )
    segment = taxonomies.create_value(
        db_session, OPERATOR, Taxonomy.COMMERCIAL_SEGMENT, "Logistique"
    )

    assert category.slug == segment.slug == "logistique"
    assert [event.action for event in audit_events(db_session)] == [
        "role.created",
        "activity_category.created",
        "commercial_segment.created",
    ]


def test_blank_or_too_long_labels_are_refused(db_session: Session) -> None:
    with pytest.raises(InvalidFieldError) as blank:
        create_role(db_session, "   ")
    with pytest.raises(InvalidFieldError):
        create_role(db_session, "x" * 256)

    assert blank.value.field == "label"


def test_slugs_stay_unique_and_fall_back_when_a_label_has_no_letters(db_session: Session) -> None:
    add_role(db_session, "responsable-achats", "Direction des achats")

    assert create_role(db_session, "Responsable achats").slug == "responsable-achats-2"
    assert create_role(db_session, "Responsable  achats (bis)").slug == "responsable-achats-bis"
    assert create_role(db_session, "—").slug == "valeur"


def test_a_duplicate_that_races_past_the_check_is_refused_by_the_database(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = create_role(db_session, "Acheteur")
    real_find = taxonomy_repository.find_by_label
    calls: list[str] = []

    def find_nothing_first(*args: object, **kwargs: object) -> object:
        calls.append("find")
        return None if len(calls) == 1 else real_find(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(taxonomy_repository, "find_by_label", find_nothing_first)

    with pytest.raises(DuplicateValueError) as refused:
        create_role(db_session, "ACHETEUR")

    assert refused.value.existing == ExistingValue(original.id, "Acheteur", True)
    # The savepoint rolled back: the transaction is still usable.
    assert db_session.execute(select(func.count()).select_from(Role)).scalar_one() == 1


# --- taxonomies: rename, deactivate, delete ---------------------------------------------------


def test_rename_keeps_the_id_the_slug_and_every_reference(db_session: Session) -> None:
    value = create_role(db_session, "Chef de quai")
    prospect = add_prospect(db_session, role_id=value.id)

    renamed = taxonomies.rename_value(db_session, OPERATOR, ROLE, value.id, "Responsable de quai")

    assert (renamed.id, renamed.slug, renamed.label, renamed.usage_count) == (
        value.id,
        "chef-de-quai",
        "Responsable de quai",
        1,
    )
    db_session.expire_all()
    assert prospect.role_id == value.id
    event = audit_events(db_session)[-1]
    assert (event.action, event.actor_id) == ("role.renamed", OPERATOR.id)
    assert event.changes == {"label": {"before": "Chef de quai", "after": "Responsable de quai"}}


def test_rename_may_fix_case_or_accents_but_not_take_another_label(db_session: Session) -> None:
    value = create_role(db_session, "responsable securite")
    other = create_role(db_session, "Directeur")

    fixed = taxonomies.rename_value(db_session, OPERATOR, ROLE, value.id, "Responsable sécurité")
    with pytest.raises(DuplicateValueError) as refused:
        taxonomies.rename_value(db_session, OPERATOR, ROLE, value.id, "DIRECTEUR")

    assert fixed.label == "Responsable sécurité"
    assert refused.value.existing == ExistingValue(other.id, "Directeur", True)


def test_renaming_to_the_same_label_changes_nothing(db_session: Session) -> None:
    value = create_role(db_session, "Gérant")

    taxonomies.rename_value(db_session, OPERATOR, ROLE, value.id, " Gérant ")

    assert [event.action for event in audit_events(db_session)] == ["role.created"]


def test_deactivation_keeps_references_and_is_audited_once(db_session: Session) -> None:
    value = create_role(db_session, "Affréteur")
    prospect = add_prospect(db_session, role_id=value.id)

    inactive = taxonomies.set_value_active(db_session, OPERATOR, ROLE, value.id, False)
    taxonomies.set_value_active(db_session, OPERATOR, ROLE, value.id, False)
    active = taxonomies.set_value_active(db_session, OPERATOR, ROLE, value.id, True)

    assert (inactive.active, active.active) == (False, True)
    db_session.expire_all()
    assert prospect.role_id == value.id
    deactivated, reactivated = audit_events(db_session)[1:]
    assert (deactivated.action, reactivated.action) == ("role.deactivated", "role.reactivated")
    assert deactivated.changes == {"active": {"before": True, "after": False}}


def test_an_unused_value_can_be_deleted(db_session: Session) -> None:
    value = create_role(db_session, "Stagiaire")

    taxonomies.delete_value(db_session, OPERATOR, ROLE, value.id)

    assert db_session.get(Role, value.id) is None
    event = audit_events(db_session)[-1]
    assert (event.action, event.entity_id, event.actor_id) == (
        "role.deleted",
        value.id,
        OPERATOR.id,
    )
    assert event.changes["label"] == {"before": "Stagiaire", "after": None}


def test_a_value_in_use_cannot_be_deleted_and_says_by_how_many(db_session: Session) -> None:
    role = create_role(db_session, "Exploitant")
    add_prospect(db_session, role_id=role.id)
    add_prospect(db_session, role_id=role.id, first_name="Marie")
    category = taxonomies.create_value(db_session, OPERATOR, Taxonomy.ACTIVITY_CATEGORY, "Fret")
    segment = taxonomies.create_value(db_session, OPERATOR, Taxonomy.COMMERCIAL_SEGMENT, "Loueur")
    add_company(
        db_session,
        commercial_segment_id=segment.id,
        activity_categories=[db_session.get(ActivityCategory, category.id)],
    )

    refusals = []
    for taxonomy, value_id in (
        (ROLE, role.id),
        (Taxonomy.ACTIVITY_CATEGORY, category.id),
        (Taxonomy.COMMERCIAL_SEGMENT, segment.id),
    ):
        with pytest.raises(InUseError) as refused:
            taxonomies.delete_value(db_session, OPERATOR, taxonomy, value_id)
        refusals.append(refused.value.usage)

    assert refusals == [{"prospects": 2}, {"companies": 1}, {"companies": 1}]
    assert db_session.get(CommercialSegment, segment.id) is not None
    assert not [event for event in audit_events(db_session) if event.action.endswith(".deleted")]


def test_a_reference_added_after_the_check_still_blocks_the_delete(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    role = create_role(db_session, "Magasinier")
    add_prospect(db_session, role_id=role.id)
    monkeypatch.setattr(taxonomies, "_refuse_if_used", lambda *args: None)

    with pytest.raises(InUseError) as refused:
        taxonomies.delete_value(db_session, OPERATOR, ROLE, role.id)

    assert refused.value.usage == {"prospects": 1}
    assert db_session.get(Role, role.id) is not None


def test_unknown_values_are_not_found(db_session: Session) -> None:
    with pytest.raises(NotFoundError):
        taxonomies.rename_value(db_session, OPERATOR, ROLE, uuid.uuid4(), "Nouveau")


# --- taxonomies: list -------------------------------------------------------------------------


def test_list_orders_by_label_counts_usage_and_filters(db_session: Session) -> None:
    used = create_role(db_session, "Écrivain public")
    create_role(db_session, "agent de transit")
    retired = create_role(db_session, "Dispatcheur")
    taxonomies.set_value_active(db_session, OPERATOR, ROLE, retired.id, False)
    add_prospect(db_session, role_id=used.id)

    listed = taxonomies.list_values(db_session, ROLE)
    active = taxonomies.list_values(db_session, ROLE, active=True)
    inactive = taxonomies.list_values(db_session, ROLE, active=False)

    assert [(value.label, value.usage_count) for value in listed] == [
        ("agent de transit", 0),
        ("Dispatcheur", 0),
        ("Écrivain public", 1),
    ]
    assert [value.label for value in active] == ["agent de transit", "Écrivain public"]
    assert [value.label for value in inactive] == ["Dispatcheur"]


def test_search_matches_every_word_ignoring_case_and_accents(db_session: Session) -> None:
    for label in ("Responsable d'exploitation", "Responsable sécurité", "Directeur d'exploitation"):
        create_role(db_session, label)

    def labels(search: str) -> list[str]:
        return [value.label for value in taxonomies.list_values(db_session, ROLE, search=search)]

    assert labels("SECURITE") == ["Responsable sécurité"]
    assert labels("exploit resp") == ["Responsable d'exploitation"]
    assert labels("100%") == []
    assert len(labels("  ")) == 3
