"""Guard: the Prospect Score is commercial fit only (S4). No graph / proximity / fiche-quality /
contact input may reach `app.services.prospect_score`."""

import ast
from pathlib import Path

from sqlalchemy.orm import Session

from app.models import User
from app.services import person_links, prospect_score
from app.services.person_links import Person
from tests.builders import FIXTURE_ACTOR, add_company, add_prospect


def _imported_modules() -> set[str]:
    tree = ast.parse(Path(prospect_score.__file__).read_text(encoding="utf-8"))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
            found.update(f"{node.module}.{alias.name}" for alias in node.names)
        elif isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
    return found


def test_the_score_module_imports_no_forbidden_input() -> None:
    imported = _imported_modules()

    for forbidden in prospect_score.FORBIDDEN_INPUTS:
        assert forbidden not in imported, f"prospect_score must not read {forbidden}"


def test_the_allowed_inputs_are_what_the_module_reads() -> None:
    imported = _imported_modules()

    for allowed in prospect_score.ALLOWED_INPUTS:
        assert allowed in imported


def test_a_relationship_link_does_not_change_the_score(
    db_session: Session, pilot_user: User
) -> None:
    company = add_company(db_session)
    prospect = add_prospect(db_session, company)
    other = add_prospect(db_session, company, first_name="Léa")
    config = prospect_score.ScoreConfig()
    before = prospect_score.get_score(db_session, prospect.id, config)

    person_links.create_link(
        db_session,
        FIXTURE_ACTOR,
        Person("prospect", prospect.id),
        Person("member", pilot_user.id),
        "ami",
        100,
        None,
    )
    person_links.create_link(
        db_session,
        FIXTURE_ACTOR,
        Person("prospect", prospect.id),
        Person("prospect", other.id),
        "collègue",
        90,
        None,
    )

    assert prospect_score.get_score(db_session, prospect.id, config) == before
