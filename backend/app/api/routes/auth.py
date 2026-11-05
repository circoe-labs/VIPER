import logging
import uuid
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field, SecretStr

from app.api.dependencies import AuthDep, SessionDep, SettingsDep
from app.api.errors import business_errors
from app.api.session_cookie import SESSION_COOKIE, clear_session_cookie, set_session_cookie
from app.core.security import MAX_PASSWORD_LENGTH, csrf_token
from app.models.organizations import OrganizationRole
from app.models.users import User
from app.services import auth as auth_service
from app.services import infomaniak_login, organizations, signups
from app.services.login_throttle import LoginThrottle

logger = logging.getLogger(__name__)

# Sign-in is the only public auth route; `public_router` is mounted without the session guard.
public_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter(prefix="/auth", tags=["auth"])

# One message for an unknown email and a wrong password: no account enumeration.
INVALID_CREDENTIALS = "Invalid email or password."


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=320)
    password: SecretStr = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


class OrganizationRef(BaseModel):
    id: uuid.UUID
    name: str


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    role: OrganizationRole
    # The single platform admin: creates organisations, manages every member.
    is_superadmin: bool
    organization: OrganizationRef


class SessionResponse(BaseModel):
    user: UserResponse
    # Echo it in the `X-CSRF-Token` header of every POST/PUT/PATCH/DELETE.
    csrf_token: str


def session_response(user: User, token: str) -> SessionResponse:
    return SessionResponse(
        user=UserResponse(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            role=user.role,
            is_superadmin=user.is_superadmin,
            organization=OrganizationRef(id=user.organization.id, name=user.organization.name),
        ),
        csrf_token=csrf_token(token),
    )


@public_router.post(
    "/login",
    responses={
        status.HTTP_401_UNAUTHORIZED: {"description": INVALID_CREDENTIALS},
        status.HTTP_429_TOO_MANY_REQUESTS: {"description": "Too many failed attempts."},
    },
)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
) -> SessionResponse:
    """Check the credentials and start a new session (fresh token; the previous one is revoked).

    Only JSON bodies are parsed, so a cross-site HTML form cannot submit it.
    """
    if not settings.password_login_allowed:
        # Infomaniak is configured: it is the only way in.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sign in with Infomaniak.")
    throttle: LoginThrottle = request.app.state.login_throttle
    email = auth_service.normalize_email(body.email)
    client = request.client.host if request.client else "unknown"
    retry_after = throttle.retry_after(email, client)
    if retry_after is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many failed attempts.",
            headers={"Retry-After": str(retry_after)},
        )
    user = auth_service.authenticate(session, email, body.password.get_secret_value())
    if user is None:
        throttle.record_failure(email, client)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, INVALID_CREDENTIALS)
    throttle.reset(email, client)
    try:
        organizations.check_can_sign_in(user, settings)
    except organizations.SignInRefused as refused:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, {"code": refused.code, "message": str(refused)}
        ) from refused
    organizations.touch_login(user)
    if previous_token := request.cookies.get(SESSION_COOKIE):
        auth_service.revoke_token(session, previous_token)
    opened = auth_service.open_session(
        session, user, auth_service.SessionPolicy.from_settings(settings)
    )
    set_session_cookie(response, opened.token, settings)
    return session_response(user, opened.token)


@router.get("/session")
def get_current_session(auth: AuthDep) -> SessionResponse:
    """The signed-in user and CSRF token; 401 when there is no live session."""
    return session_response(auth.user, auth.token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(auth: AuthDep, session: SessionDep, settings: SettingsDep, response: Response) -> None:
    auth_service.sign_out(session, auth.record)
    clear_session_cookie(response, settings)


# --- « Se connecter avec Infomaniak » ------------------------------------------------------------

# The flow cookie travels only to the callback; `Lax` because Infomaniak sends the browser back
# with a cross-site top-level navigation (a `Strict` cookie would not come along).
FLOW_COOKIE = "viper_infomaniak_flow"
FLOW_COOKIE_PATH = "/api/auth/infomaniak"
FLOW_SECONDS = 600
CALLBACK_PATH = "/api/auth/infomaniak/callback"


class SignInMethods(BaseModel):
    infomaniak: bool
    password: bool


@public_router.get("/methods")
def sign_in_methods(settings: SettingsDep) -> SignInMethods:
    """What the sign-in page offers: Infomaniak once configured, the password form otherwise."""
    return SignInMethods(
        infomaniak=settings.infomaniak_configured, password=settings.password_login_allowed
    )


def _callback_uri(request: Request) -> str:
    # Behind the proxy, uvicorn's `--proxy-headers` gives the public scheme and host.
    return str(request.base_url).rstrip("/") + CALLBACK_PATH


def _back_to_login(error: str) -> RedirectResponse:
    return RedirectResponse(f"/login?erreur={quote(error)}", status.HTTP_302_FOUND)


@public_router.get("/infomaniak")
def infomaniak_start(request: Request, settings: SettingsDep) -> RedirectResponse:
    if not settings.infomaniak_configured:
        return _back_to_login("unavailable")
    started = infomaniak_login.start(settings, _callback_uri(request))
    response = RedirectResponse(started.url, status.HTTP_302_FOUND)
    response.set_cookie(
        FLOW_COOKIE,
        started.cookie,
        max_age=FLOW_SECONDS,
        path=FLOW_COOKIE_PATH,
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return response


@public_router.get("/infomaniak/callback")
def infomaniak_callback(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    """Back from Infomaniak: check the flow, identify the person, open the VIPER session."""
    verifier = infomaniak_login.verifier_for(request.cookies.get(FLOW_COOKIE), state)
    if not settings.infomaniak_configured:
        response = _back_to_login("unavailable")
    elif error is not None:
        response = _back_to_login("cancelled")
    elif verifier is None or not code:
        response = _back_to_login("expired")
    else:
        response = _sign_in(request, session, settings, code=code, verifier=verifier)
    response.delete_cookie(
        FLOW_COOKIE, path=FLOW_COOKIE_PATH, secure=settings.session_cookie_secure, httponly=True
    )
    return response


def _sign_in(
    request: Request, session: SessionDep, settings: SettingsDep, *, code: str, verifier: str
) -> RedirectResponse:
    try:
        identity = infomaniak_login.identify(
            settings,
            code=code,
            verifier=verifier,
            redirect_uri=_callback_uri(request),
            transport=getattr(request.app.state, "infomaniak_transport", None),
        )
    except infomaniak_login.InfomaniakError as failure:
        logger.warning("infomaniak.signin_failed reason=%s", failure)
        return _back_to_login("infomaniak")
    try:
        user = organizations.sign_in_identity(session, settings, identity)
    except organizations.SignInRefused as refused:
        logger.info("infomaniak.signin_refused code=%s", refused.code)
        return _back_to_login(refused.code)
    organizations.touch_login(user)
    if previous_token := request.cookies.get(SESSION_COOKIE):
        auth_service.revoke_token(session, previous_token)
    opened = auth_service.open_session(
        session, user, auth_service.SessionPolicy.from_settings(settings)
    )
    response = RedirectResponse("/", status.HTTP_302_FOUND)
    set_session_cookie(response, opened.token, settings)
    return response


# --- « Créer un compte » (services/signups.py) ---------------------------------------------------


class SignupRequest(BaseModel):
    email: str = Field(min_length=1, max_length=320)
    display_name: str = Field(min_length=1, max_length=255)
    password: SecretStr = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


class SignupAccepted(BaseModel):
    status: str = "pending"


@public_router.post(
    "/signup",
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        status.HTTP_422_UNPROCESSABLE_CONTENT: {"description": "Refused: `{code, message}`."},
        status.HTTP_429_TOO_MANY_REQUESTS: {"description": "Too many requests."},
    },
)
def signup(
    body: SignupRequest,
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    background: BackgroundTasks,
) -> SignupAccepted:
    """Ask for an account: created deactivated, the platform admin is e-mailed a confirmation
    link. The same answer whether the address already has an account or not."""
    throttle: LoginThrottle = request.app.state.login_throttle
    client = request.client.host if request.client else "unknown"
    email = auth_service.normalize_email(body.email)
    retry_after = throttle.retry_after(email, client)
    if retry_after is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many requests.",
            headers={"Retry-After": str(retry_after)},
        )
    # Counted like a failed sign-in: a client cannot flood the admin's mailbox.
    throttle.record_failure(email, client)
    try:
        requested = signups.request_signup(
            session,
            email=email,
            display_name=body.display_name,
            password=body.password.get_secret_value(),
            allowed_domains=settings.signin_domains,
        )
    except signups.SignupRefused as refused:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, {"code": refused.code, "message": str(refused)}
        ) from refused
    if requested is not None:
        link = str(request.base_url).rstrip("/") + f"/inscriptions/{requested.token}"
        background.add_task(
            signups.notify_admin,
            request.app.state.session_factory,
            request.app.state.toolbox.mail_toolbox(),
            user_id=requested.user_id,
            link=link,
        )
    return SignupAccepted()


class SignupOut(BaseModel):
    email: str
    display_name: str
    organization: str
    requested_at: datetime | None


@router.get("/signups/{token}")
def get_signup(token: str, auth: AuthDep, session: SessionDep) -> SignupOut:
    with business_errors():
        user = signups.pending_by_token(session, token)
        return SignupOut(
            email=user.email,
            display_name=user.display_name,
            organization=user.organization.name,
            requested_at=user.signup_requested_at,
        )


@router.post("/signups/{token}/approve")
def approve_signup(token: str, auth: AuthDep, session: SessionDep) -> SignupOut:
    with business_errors():
        user = signups.approve(session, auth.user, token)
        return SignupOut(
            email=user.email,
            display_name=user.display_name,
            organization=user.organization.name,
            requested_at=None,
        )


@router.post("/signups/{token}/refuse", status_code=status.HTTP_204_NO_CONTENT)
def refuse_signup(token: str, auth: AuthDep, session: SessionDep) -> None:
    with business_errors():
        signups.refuse(session, auth.user, token)
