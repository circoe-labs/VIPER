"""API routers, both mounted under `/api` by `create_app`.

Protected by default: include every new feature router in `api_router`, whose dependency requires
a live session (and a CSRF token on unsafe methods). `public_router` is the explicit, minimal
allowlist of routes reachable without a session; `tests/test_route_protection.py` pins it.
"""

from fastapi import APIRouter, Depends

from app.api.dependencies import require_session
from app.api.routes import (
    audit,
    auth,
    companies,
    contact,
    contact_messages,
    database_reset,
    explorer,
    explorer_sql,
    explorer_writes,
    exports,
    health,
    home,
    imports,
    integrations,
    prospection,
    prospects,
    search,
    sequences,
    settings,
    toolbox,
)

public_router = APIRouter()
public_router.include_router(health.router)
public_router.include_router(auth.public_router)

api_router = APIRouter(dependencies=[Depends(require_session)])
api_router.include_router(auth.router)
api_router.include_router(audit.router)
api_router.include_router(companies.router)
api_router.include_router(contact.router)
api_router.include_router(contact_messages.router)
api_router.include_router(database_reset.router)
api_router.include_router(explorer.router)
api_router.include_router(explorer_writes.router)
api_router.include_router(explorer_sql.router)
api_router.include_router(exports.router)
api_router.include_router(home.router)
api_router.include_router(imports.router)
api_router.include_router(prospection.router)
api_router.include_router(prospects.router)
api_router.include_router(search.router)
# Before `settings`: its `/settings/{taxonomy}` would otherwise capture `/settings/toolbox` and
# `/settings/integrations`.
api_router.include_router(toolbox.router)
api_router.include_router(integrations.router)
api_router.include_router(sequences.router)
api_router.include_router(settings.router)
