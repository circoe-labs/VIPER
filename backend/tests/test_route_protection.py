"""Every API route needs a session except an explicit allowlist; routes get the session's actor."""

import re
import uuid
from typing import Any

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute, iter_route_contexts
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import router as api_routers
from app.api.dependencies import CurrentActor, SessionDep
from app.core.actor import ActorType
from app.models import ContactTrackingStatusHistory, User
from app.models.enums import ContactTrackingStatus
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from tests.builders import add_prospect

# The only routes reachable without a session. Widening this set is a security decision (ADR-0004).
PUBLIC_ROUTES = {("GET", "/api/health"), ("POST", "/api/auth/login")}
# Framework routes outside the routers: the OpenAPI schema and its viewer (no data).
DOCUMENTATION_PATHS = {"/api/openapi.json", "/api/docs"}


def api_routes(app: FastAPI) -> list[tuple[str, str]]:
    """(method, path) of every endpoint, included routers flattened with their prefixes."""
    return sorted(
        (method, str(context.path))
        for context in iter_route_contexts(app.routes)
        if isinstance(context.original_route, APIRoute)
        for method in context.methods or ()
    )


def concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", str(uuid.uuid4()), path)


def test_only_allowlisted_routes_answer_without_a_session(
    app: FastAPI, anonymous_client: TestClient
) -> None:
    routes = api_routes(app)
    assert {("GET", "/api/auth/session"), ("POST", "/api/auth/logout")} < set(routes)
    assert all(path.startswith("/api/") for _, path in routes)

    reachable = {
        (method, path)
        for method, path in routes
        if anonymous_client.request(method, concrete(path)).status_code != 401
    }

    assert reachable == PUBLIC_ROUTES


def test_the_only_other_routes_are_the_api_documentation(app: FastAPI) -> None:
    other_paths = {
        context.path
        for context in iter_route_contexts(app.routes)
        if not isinstance(context.original_route, APIRoute)
    }

    assert other_paths == DOCUMENTATION_PATHS


def test_a_router_added_to_api_router_is_protected_without_opting_in(
    monkeypatch: pytest.MonkeyPatch, app: FastAPI, client: TestClient, anonymous_client: TestClient
) -> None:
    monkeypatch.setattr(api_routers.api_router, "routes", list(api_routers.api_router.routes))
    feature = APIRouter(prefix="/feature-probe")
    feature.add_api_route("", lambda: {"ok": True}, methods=["GET"])
    # Included routers are live: the running app picks up the new router with the guard.
    api_routers.api_router.include_router(feature)

    assert anonymous_client.get("/api/feature-probe").status_code == 401
    assert client.get("/api/feature-probe").json() == {"ok": True}


def test_mutation_services_receive_the_authenticated_actor_not_the_payload(
    app: FastAPI,
    client: TestClient,
    anonymous_client: TestClient,
    pilot_user: User,
    db_session: Session,
) -> None:
    @app.post("/api/test-tracking/{prospect_id}", status_code=204)
    def track(
        prospect_id: uuid.UUID, payload: dict[str, Any], session: SessionDep, actor: CurrentActor
    ) -> None:
        tracking = ContactTrackingInput(status=ContactTrackingStatus.CONTACTED)
        save_contact_tracking(session, actor, prospect_id, tracking)

    prospect_id = add_prospect(db_session).id
    forged = {"actor": {"type": "agent", "id": "forged-id", "display": "Forged Actor"}}

    assert (
        anonymous_client.post(f"/api/test-tracking/{prospect_id}", json=forged).status_code == 401
    )
    assert client.post(f"/api/test-tracking/{prospect_id}", json=forged).status_code == 204

    history = db_session.execute(select(ContactTrackingStatusHistory)).scalar_one()
    assert (history.actor_type, history.actor_id, history.actor_display) == (
        ActorType.HUMAN,
        str(pilot_user.id),
        "Pilote Test",
    )
