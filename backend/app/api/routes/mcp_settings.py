"""Paramètres > MCP: what VIPER exposes to agents, with the parameters of each tool, and who may
connect (« Accès autorisés »: command-line tokens and OAuth connectors, revocable).

The tools are code (`app.api.mcp.TOOLS`), the page only renders them. The parameter list is
digested here rather than in the browser, so the UI stays a viewer and the JSON Schema keeps a
single source. A token is never returned, only its label and dates.
"""

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentActor, SessionDep
from app.api.mcp import PROTOCOL_VERSION, TOOLS
from app.models.mcp import McpToken
from app.models.oauth import OAuthAuthorization
from app.services import oauth

router = APIRouter(prefix="/settings", tags=["settings"])


class McpParameterOut(BaseModel):
    name: str
    type: str
    required: bool
    description: str | None
    enum: list[str] | None


class McpToolOut(BaseModel):
    name: str
    description: str
    parameters: list[McpParameterOut]


class McpSettingsOut(BaseModel):
    endpoint: str
    protocol_version: str
    tools: list[McpToolOut]


def _type_of(prop: dict[str, Any]) -> str:
    kind = prop.get("type")
    if kind == "array":
        items = prop.get("items") or {}
        inner = items.get("type", "objet")
        return f"liste de {inner}"
    return str(kind or "objet")


def _parameters(schema: dict[str, Any]) -> list[McpParameterOut]:
    required = set(schema.get("required", []))
    properties: dict[str, Any] = schema.get("properties", {})
    return [
        McpParameterOut(
            name=name,
            type=_type_of(prop),
            required=name in required,
            description=prop.get("description"),
            enum=[
                str(value)
                for value in (prop.get("enum") or (prop.get("items") or {}).get("enum", []))
            ]
            or None,
        )
        for name, prop in properties.items()
    ]


@router.get("/mcp")
def mcp_settings() -> McpSettingsOut:
    """The tools an agent can call, with their parameters. What « Paramètres > MCP » shows."""
    return McpSettingsOut(
        endpoint="/mcp",
        protocol_version=PROTOCOL_VERSION,
        tools=[
            McpToolOut(
                name=tool["name"],
                description=tool["description"],
                parameters=_parameters(tool["inputSchema"]),
            )
            for tool in TOOLS
        ],
    )


class McpAgentOut(BaseModel):
    id: uuid.UUID
    label: str
    # `oauth`: approved from a connector (ChatGPT, Claude…); `cli`: made in the command line.
    origin: str
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


@router.get("/mcp/agents")
def mcp_agents(session: SessionDep) -> list[McpAgentOut]:
    """« Accès autorisés »: every agent credential, live ones first."""
    oauth_ids = set(
        session.scalars(
            select(OAuthAuthorization.mcp_token_id).where(
                OAuthAuthorization.mcp_token_id.is_not(None)
            )
        )
    )
    records = session.scalars(
        select(McpToken).order_by(McpToken.revoked_at.is_not(None), McpToken.created_at.desc())
    )
    return [
        McpAgentOut(
            id=record.id,
            label=record.label,
            origin="oauth" if record.id in oauth_ids else "cli",
            created_at=record.created_at,
            last_used_at=record.last_used_at,
            revoked_at=record.revoked_at,
        )
        for record in records
    ]


@router.post("/mcp/agents/{agent_id}/revoke")
def revoke_mcp_agent(agent_id: uuid.UUID, session: SessionDep, actor: CurrentActor) -> McpAgentOut:
    """« Révoquer »: the agent can no longer call `/mcp`, its OAuth tokens included."""
    try:
        record = oauth.revoke_agent(session, agent_id)
    except oauth.OAuthError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, {"code": "not_found", "message": "Unknown agent."}
        ) from None
    return McpAgentOut(
        id=record.id,
        label=record.label,
        origin="oauth" if oauth.is_oauth_agent(session, record.id) else "cli",
        created_at=record.created_at,
        last_used_at=record.last_used_at,
        revoked_at=record.revoked_at,
    )
