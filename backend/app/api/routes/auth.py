import uuid

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, SecretStr

from app.api.dependencies import AuthDep, SessionDep, SettingsDep
from app.api.session_cookie import SESSION_COOKIE, clear_session_cookie, set_session_cookie
from app.core.security import MAX_PASSWORD_LENGTH, csrf_token
from app.models.users import User
from app.services import auth as auth_service
from app.services.login_throttle import LoginThrottle

# Sign-in is the only public auth route; `public_router` is mounted without the session guard.
public_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter(prefix="/auth", tags=["auth"])

# One message for an unknown email and a wrong password: no account enumeration.
INVALID_CREDENTIALS = "Invalid email or password."


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=320)
    password: SecretStr = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str


class SessionResponse(BaseModel):
    user: UserResponse
    # Echo it in the `X-CSRF-Token` header of every POST/PUT/PATCH/DELETE.
    csrf_token: str


def session_response(user: User, token: str) -> SessionResponse:
    return SessionResponse(
        user=UserResponse(id=user.id, email=user.email, display_name=user.display_name),
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
