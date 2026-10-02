"""Wake the Toolbox cleanup worker after a write that may have queued a remote draft (S6).

Message edits and cancellations, Contact state changes and the opposition all live under
`/api/prospects`: after a successful unsafe request there, the worker runs a pass right away
instead of waiting for its interval. Pure ASGI (like `security_headers`): bodies untouched.
"""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

WAKING_PREFIX = "/api/prospects"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class WakeCleanupWorkerMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] in SAFE_METHODS
            or not scope["path"].startswith(WAKING_PREFIX)
        ):
            await self.app(scope, receive, send)
            return
        status = 500

        async def record_status(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        await self.app(scope, receive, record_status)
        worker = getattr(scope["app"].state, "toolbox_worker", None)
        if worker is not None and status < 400:
            worker.wake()
