"""Security headers on every API response (Task 20).

The API answers JSON (and CSV/XLSX downloads) holding personal data to one same-origin SPA: no
browser may sniff another content type, frame it, send its URLs as referrer or keep it in a cache.
A response that sets one of these headers itself keeps its value. The SPA's HTML and assets are
served by the reverse proxy in production, which sets their own headers (runbook-production.md).
"""

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
}


class SecurityHeadersMiddleware:
    """Pure ASGI middleware: adds the headers to the response start, streamed bodies untouched."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                for name, value in SECURITY_HEADERS.items():
                    headers.setdefault(name, value)
            await send(message)

        await self.app(scope, receive, send_with_headers)
