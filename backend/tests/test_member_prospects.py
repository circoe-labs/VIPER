"""Members of the organisation are prospects too, never contacted (services/member_prospects.py)."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.companies import Company
from app.models.enums import ContactabilityStatus
from app.models.organizations import CIRCOE_ORGANIZATION_ID
from app.models.prospects import Prospect
from app.services import member_prospects
from app.services.member_prospects import MEMBER_ACTOR, MEMBER_REASON
from tests.builders import add_company, add_prospect, add_user


def test_member_without_fiche_gets_a_blocked_one_in_the_owner_company(db_session: Session) -> None:
    user = add_user(db_session, email="anne.martin@circoe.com", display_name="Anne Martin")
    prospect = member_prospects.ensure_member_prospect(db_session, MEMBER_ACTOR, user)
    assert prospect is not None
    assert (prospect.first_name, prospect.last_name) == ("Anne", "Martin")
    assert prospect.member_user_id == user.id
    assert prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert prospect.do_not_contact_reason == MEMBER_REASON
    company = db_session.get(Company, prospect.company_id)
    assert company is not None and company.represents_organization_id == CIRCOE_ORGANIZATION_ID
    assert [email.address for email in prospect.emails] == ["anne.martin@circoe.com"]


def test_lone_last_name_in_the_owner_company_is_joined_not_duplicated(db_session: Session) -> None:
    circoe = add_company(db_session, "CIRCOE", organization_id=CIRCOE_ORGANIZATION_ID)
    existing = add_prospect(db_session, circoe, first_name=None, last_name="pote")
    user = add_user(db_session, email="robin@circoe.com", display_name="Robin Poté")
    prospect = member_prospects.ensure_member_prospect(db_session, MEMBER_ACTOR, user)
    assert prospect is not None and prospect.id == existing.id
    assert circoe.represents_organization_id == CIRCOE_ORGANIZATION_ID
    assert prospect.member_user_id == user.id
    assert prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert db_session.scalars(select(Prospect).where(Prospect.last_name == "pote")).all() == [
        existing
    ]


def test_ensure_is_idempotent(db_session: Session) -> None:
    user = add_user(db_session, email="b@circoe.com", display_name="Bob Lee")
    first = member_prospects.ensure_member_prospect(db_session, MEMBER_ACTOR, user)
    second = member_prospects.ensure_member_prospect(db_session, MEMBER_ACTOR, user)
    assert first is not None and second is not None and first.id == second.id
    assert (
        len(db_session.scalars(select(Prospect).where(Prospect.member_user_id == user.id)).all())
        == 1
    )
