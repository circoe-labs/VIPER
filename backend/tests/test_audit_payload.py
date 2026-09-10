"""Audit payloads: JSON-safe change sets and the central payload policy (no database)."""

import uuid
from dataclasses import replace
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from app.core import audit_policy
from app.core.actor import ActorType
from app.core.audit_policy import MASKED_VALUE, OMITTED_VALUE, PersonalValues, sanitize_changes
from app.models.enums import ContactTrackingStatus
from app.services.audit_changes import ChangeSet, diff, to_json

POLICY = audit_policy.POLICY


def test_values_are_serialized_to_json_safe_data() -> None:
    ident = uuid.uuid7()
    moment = datetime(2026, 9, 14, 9, 30, tzinfo=UTC)

    assert to_json(
        {
            "id": ident,
            "at": moment,
            "day": date(2026, 9, 14),
            "amount": Decimal("12.50"),
            "status": ContactTrackingStatus.CONTACTED,
            "actor": ActorType.IMPORT,
            "sheets": ("Prospects", "Archive"),
            "tags": {"b", "a"},
            "nested": [{"n": 1, "ok": True, "none": None, "ratio": 0.5}],
        }
    ) == {
        "id": str(ident),
        "at": "2026-09-14T09:30:00+00:00",
        "day": "2026-09-14",
        "amount": "12.50",
        "status": "contacted",
        "actor": "import",
        "sheets": ["Prospects", "Archive"],
        "tags": ["a", "b"],
        "nested": [{"n": 1, "ok": True, "none": None, "ratio": 0.5}],
    }


def test_unknown_types_are_refused_rather_than_stringified() -> None:
    with pytest.raises(TypeError, match="bytes"):
        to_json(b"raw workbook bytes")


def test_diff_keeps_only_changed_fields() -> None:
    before = {"first_name": "Jean", "last_name": "Test", "role_id": None}
    after = {"first_name": "Jean", "last_name": "Exemple", "exact_job_title": "Gérant"}

    assert diff(before, after) == {
        "exact_job_title": {"before": None, "after": "Gérant"},
        "last_name": {"before": "Test", "after": "Exemple"},
    }


def test_secret_fields_are_dropped_at_any_depth() -> None:
    changes: ChangeSet = {
        "password_hash": {"before": "$argon2id$old", "after": "$argon2id$new"},
        "api_token": {"before": None, "after": "t0k3n"},
        "notes": {
            "before": None,
            "after": {"csrf_token": "x", "text": "ok", "items": [{"secret_key": "y", "n": 1}]},
        },
    }

    assert sanitize_changes("prospect", changes, POLICY) == {
        "notes": {"before": None, "after": {"text": "ok", "items": [{"n": 1}]}}
    }


def test_account_entities_never_carry_field_values() -> None:
    changes = {
        "email": {"before": "a@example.com", "after": "b@example.com"},
        "display_name": {"before": "A", "after": "B"},
    }

    assert sanitize_changes("user", changes, POLICY) == {}
    assert sanitize_changes("user_session", changes, POLICY) == {}


def test_masked_fields_only_show_that_they_changed() -> None:
    changes = {"legacy_metadata": {"before": None, "after": {"Mode de contact": "Auto"}}}

    assert sanitize_changes("import_row", changes, POLICY) == {
        "legacy_metadata": {"before": None, "after": MASKED_VALUE}
    }


PERSONAL_CHANGES = {
    ("email", "address"): ("jean.test@example.com", "j•••@example.com"),
    ("phone", "number"): ("+33100000042", "•••42"),
    ("prospect", "last_name"): ("Exemple", "E•••"),
}


@pytest.mark.parametrize("mode", list(PersonalValues))
def test_personal_values_follow_the_single_policy_switch(mode: PersonalValues) -> None:
    policy = replace(POLICY, personal_values=mode)

    for (entity_type, field), (full, masked) in PERSONAL_CHANGES.items():
        expected = {
            PersonalValues.FULL: full,
            PersonalValues.MASKED: masked,
            PersonalValues.OMITTED: OMITTED_VALUE,
        }[mode]
        stored = sanitize_changes(entity_type, {field: {"before": None, "after": full}}, policy)
        assert stored == {field: {"before": None, "after": expected}}
    # Non-personal fields are untouched whatever the mode.
    title = {"exact_job_title": {"before": "Gérant", "after": "Directeur"}}
    assert sanitize_changes("prospect", title, policy) == title


def test_v1_keeps_personal_values_in_full() -> None:
    assert POLICY.personal_values is PersonalValues.FULL
