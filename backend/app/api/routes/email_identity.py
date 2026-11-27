"""« Identité e-mail » (`app.services.email_identity`): the doubt as every payload shows it, and
a person's explicit confirmation (`POST /prospects/{id}/email-identity`, and `…/revoke`), recorded
with who and when. Refusals: 403 `human_actor_required`, 404 `not_found`, 422 `invalid`."""

import uuid

from fastapi import APIRouter, status
from pydantic import BaseModel, ConfigDict

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.services import email_identity
from app.services.email_identity import Reason

router = APIRouter(tags=["email identity"])


class IdentityDoubtOut(BaseModel):
    """An address that looks like someone else's, and why."""

    model_config = ConfigDict(from_attributes=True)

    address: str
    reason: Reason
    # The other person it points to (a colleague, another holder).
    other_name: str | None
    other_id: uuid.UUID | None


class AddressIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    address: str


@router.post("/prospects/{prospect_id}/email-identity", status_code=status.HTTP_204_NO_CONTENT)
def confirm(
    prospect_id: uuid.UUID, body: AddressIn, session: SessionDep, actor: CurrentActor
) -> None:
    """« C'est bien son adresse »."""
    with business_errors():
        email_identity.confirm(session, actor, prospect_id, body.address)


@router.post(
    "/prospects/{prospect_id}/email-identity/revoke", status_code=status.HTTP_204_NO_CONTENT
)
def revoke(
    prospect_id: uuid.UUID, body: AddressIn, session: SessionDep, actor: CurrentActor
) -> None:
    with business_errors():
        email_identity.revoke(session, actor, prospect_id, body.address)
