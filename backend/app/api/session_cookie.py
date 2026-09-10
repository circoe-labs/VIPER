"""The session cookie and CSRF header contract between the API and the browser (ADR-0004)."""

from fastapi import Response

from app.core.config import Settings

SESSION_COOKIE = "viper_session"
# Only API calls need the cookie; SPA pages and assets never receive it.
SESSION_COOKIE_PATH = "/api"
# Unsafe methods (POST/PUT/PATCH/DELETE) must echo the session's CSRF token in this header.
CSRF_HEADER = "X-CSRF-Token"


def set_session_cookie(response: Response, token: str, settings: Settings) -> None:
    # SameSite=Strict costs nothing here: the cookie is scoped to /api, which is never the target
    # of a top-level cross-site navigation; the SPA's own fetches are same-site.
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=settings.session_absolute_timeout_hours * 3600,
        path=SESSION_COOKIE_PATH,
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="strict",
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        SESSION_COOKIE,
        path=SESSION_COOKIE_PATH,
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="strict",
    )


def cleared_session_cookie_header(settings: Settings) -> dict[str, str]:
    """`Set-Cookie` header expiring the cookie, for error responses raised as exceptions."""
    response = Response()
    clear_session_cookie(response, settings)
    return {"set-cookie": response.headers["set-cookie"]}
