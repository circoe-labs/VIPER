"""Members of the organisation are also prospects: a fiche with a special, never-contacted status.

Every member (login account) has exactly one prospect fiche (`prospects.member_user_id`) in the
company that *is* their organisation (`companies.represents_organization_id`: CIRCOE for the
first one). The fiche is `do_not_contact` (reason « Membre de l'organisation »), so no mission,
sequence or dispatch ever targets a colleague, while the relations graph and the proximity score
can treat the member as any person of the base.

A member who already exists as a prospect (« Poté » in CIRCOE for Robin Poté, or the same
address) is **joined to that fiche**, not duplicated. `ensure_member_prospect` is idempotent: it
runs when a member is added or first signs in, and `sync_members` runs at start-up to catch up
the existing accounts.
"""

import logging
import unicodedata

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext, ActorType
from app.models.companies import Company
from app.models.enums import ContactabilityStatus
from app.models.organizations import CIRCOE_ORGANIZATION_ID, Organization
from app.models.prospects import Email, Prospect
from app.models.users import User
from app.services import audit
from app.services import prospects as prospect_service

logger = logging.getLogger(__name__)

MEMBER_REASON = "Membre de l'organisation"
MEMBER_ACTOR = ActorContext(
    type=ActorType.SYSTEM, display="VIPER — membres de l'organisation", id="member-prospects"
)


def _key(text: str | None) -> str:
    """Lowercase, unaccented, single-spaced: « Poté » and « pote » compare equal."""
    folded = unicodedata.normalize("NFKD", text or "")
    return " ".join("".join(c for c in folded if not unicodedata.combining(c)).lower().split())


def split_name(display_name: str) -> tuple[str | None, str | None]:
    """« Robin Poté » → (Robin, Poté); a single word is the last name."""
    parts = display_name.split()
    if len(parts) <= 1:
        return None, display_name.strip() or None
    return parts[0], " ".join(parts[1:])


def owner_company(session: Session, actor: ActorContext, organization: Organization) -> Company:
    """The company standing for the organisation: found by its marker, else by its e-mail domain
    or name (and marked), else created."""
    company = session.scalar(
        select(Company).where(Company.represents_organization_id == organization.id)
    )
    if company is None:
        match = func.lower(Company.display_name) == organization.name.lower()
        if organization.email_domain:
            match = or_(match, Company.email_domain == organization.email_domain)
        company = session.scalar(
            select(Company)
            .where(Company.organization_id == organization.id, match)
            .order_by(Company.created_at)
            .limit(1)
        )
    if company is None:
        company = Company(
            display_name=organization.name,
            email_domain=organization.email_domain,
            organization_id=organization.id,
        )
        session.add(company)
    audit.annotate(session, actor, company)
    company.represents_organization_id = organization.id
    session.flush()
    return company


def _match_existing(session: Session, user: User, company: Company) -> Prospect | None:
    """An unlinked prospect that is this member: same address, else same name in the company
    (a lone last name « Poté » matches Robin Poté)."""
    by_email = session.scalar(
        select(Prospect)
        .join(Email, Email.prospect_id == Prospect.id)
        .where(Email.address == user.email.lower(), Prospect.member_user_id.is_(None))
        .limit(1)
    )
    if by_email is not None:
        return by_email
    first, last = (_key(part) for part in split_name(user.display_name))
    full = _key(user.display_name)
    for prospect in session.scalars(
        select(Prospect).where(Prospect.company_id == company.id, Prospect.member_user_id.is_(None))
    ):
        p_first, p_last = _key(prospect.first_name), _key(prospect.last_name)
        if p_last not in (last, full):
            continue
        if not p_first or not first or p_first == first or first.startswith(p_first):
            return prospect
    return None


def ensure_member_prospect(session: Session, actor: ActorContext, user: User) -> Prospect | None:
    """The member's fiche, created or joined, and made `do_not_contact`. A pending sign-up (not
    approved yet) is not a member."""
    if not user.is_active and user.signup_requested_at is not None:
        return None
    # Only CIRCOE signs in for now (doc/architecture/organizations.md): another organisation's
    # members get their fiches when its data is isolated per organisation.
    if user.organization_id != CIRCOE_ORGANIZATION_ID:
        return None
    organization = session.get(Organization, user.organization_id)
    if organization is None:
        return None
    company = owner_company(session, actor, organization)
    address = prospect_service.ChannelInput(user.email.lower(), is_primary=True)
    prospect = session.scalar(select(Prospect).where(Prospect.member_user_id == user.id))
    if prospect is None:
        prospect = _match_existing(session, user, company)
    if prospect is None:
        first, last = split_name(user.display_name)
        prospect = prospect_service.create_prospect(
            session,
            actor,
            prospect_service.ProspectInput(
                first_name=first, last_name=last, company_id=company.id, emails=(address,)
            ),
        )
    else:
        audit.annotate(session, actor, prospect)
        if prospect.company_id is None:
            prospect.company_id = company.id
        prospect_service.add_channels(session, actor, prospect, emails=(address,))
    audit.annotate(session, actor, prospect)
    prospect.member_user_id = user.id
    session.flush()
    if prospect.contactability_status is not ContactabilityStatus.DO_NOT_CONTACT:
        prospect_service.record_do_not_contact(session, actor, prospect.id, reason=MEMBER_REASON)
    return prospect


def sync_members(session_factory: sessionmaker[Session]) -> int:
    """Catch up every member without a fiche; one transaction per member, so one failure (logged)
    blocks neither the others nor the start-up."""
    try:
        with session_factory() as session:
            user_ids = list(
                session.scalars(
                    select(User.id)
                    .outerjoin(Prospect, Prospect.member_user_id == User.id)
                    .where(Prospect.id.is_(None))
                )
            )
    except Exception:  # the schema may not be migrated yet (tests, first start)
        logger.exception("member_prospects.sync_unavailable")
        return 0
    done = 0
    for user_id in user_ids:
        try:
            with audit.attributed_unit_of_work(session_factory, MEMBER_ACTOR) as session:
                user = session.get(User, user_id)
                if user is not None and ensure_member_prospect(session, MEMBER_ACTOR, user):
                    done += 1
        except Exception:
            logger.exception("member_prospects.sync_failed")
    return done
