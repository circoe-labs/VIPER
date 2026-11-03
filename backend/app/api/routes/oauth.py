"""« Autoriser … à accéder à VIPER ? » (`/api/oauth/requests/*`): the person's decision on a
connector's OAuth request. Session-protected like every `/api` route (the CSRF header included):
only a signed-in person can approve. The public half of the flow is `app/api/oauth.py`.
"""

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.api.dependencies import AuthDep, SessionDep
from app.services import oauth
from app.services.oauth import OAuthError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/oauth", tags=["oauth"])


class OAuthRequestOut(BaseModel):
    id: uuid.UUID
    client_name: str
    # Where the answer goes (the connector's host), so the person recognises it.
    redirect_host: str
    expires_at: datetime


class OAuthDecisionOut(BaseModel):
    # The connector's redirect URI with the code (or `error=access_denied`): the page goes there.
    redirect: str


def _not_found(error: OAuthError) -> HTTPException:
    return HTTPException(
        status.HTTP_404_NOT_FOUND,
        {"code": "oauth_request_unavailable", "message": error.description},
    )


@router.get("/requests/{request_id}")
def read_request(request_id: uuid.UUID, session: SessionDep) -> OAuthRequestOut:
    try:
        pending = oauth.describe(session, request_id)
    except OAuthError as error:
        raise _not_found(error) from None
    return OAuthRequestOut(
        id=pending.id,
        client_name=pending.client_name,
        redirect_host=pending.redirect_host,
        expires_at=pending.expires_at,
    )


@router.post("/requests/{request_id}/approve")
def approve_request(request_id: uuid.UUID, session: SessionDep, auth: AuthDep) -> OAuthDecisionOut:
    try:
        redirect = oauth.approve(session, request_id, auth.user)
    except OAuthError as error:
        raise _not_found(error) from None
    logger.info("oauth.request_approved request=%s by=%s", request_id, auth.user.id)
    return OAuthDecisionOut(redirect=redirect)


@router.post("/requests/{request_id}/deny")
def deny_request(request_id: uuid.UUID, session: SessionDep, auth: AuthDep) -> OAuthDecisionOut:
    try:
        redirect = oauth.deny(session, request_id)
    except OAuthError as error:
        raise _not_found(error) from None
    logger.info("oauth.request_denied request=%s by=%s", request_id, auth.user.id)
    return OAuthDecisionOut(redirect=redirect)
