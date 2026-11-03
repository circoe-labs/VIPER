"""Paramètres > MCP: what VIPER exposes to agents, with the parameters of each tool, and who may
connect (« Accès autorisés »: command-line tokens and OAuth connectors, revocable).

The tools are code (`app.api.mcp.TOOLS`), the page only renders them. The parameter list is
digested here rather than in the browser, so the UI stays a viewer and the JSON Schema keeps a
single source. A token is never returned, only its label and dates.
"""

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.dependencies import AuthDep, CurrentActor, SessionDep
from app.api.errors import business_errors
from app.api.mcp import PROTOCOL_VERSION, TOOLS
from app.models.enums import AgentMode, AgentProvider
from app.models.mcp import LABEL_MAX_LENGTH, McpToken
from app.models.oauth import OAuthAuthorization
from app.services import agent_capabilities, mcp_calls, mcp_tokens, oauth

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


class McpCapabilityOut(BaseModel):
    name: str
    label: str


class McpSettingsOut(BaseModel):
    endpoint: str
    protocol_version: str
    tools: list[McpToolOut]
    # The capability vocabulary, and what each mode receives by default (« Créer un jeton »).
    capabilities: list[McpCapabilityOut]
    mode_defaults: dict[AgentMode, list[str]]


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
        capabilities=[
            McpCapabilityOut(name=name, label=agent_capabilities.CAPABILITY_LABELS[name])
            for name in agent_capabilities.CAPABILITIES
        ],
        mode_defaults={mode: agent_capabilities.defaults(mode) for mode in AgentMode},
    )


class McpAgentOut(BaseModel):
    id: uuid.UUID
    label: str
    # `oauth`: approved from a connector (ChatGPT, Claude…); `cli`: made in the command line.
    origin: str
    # The person the agent acts for: its calls are kept under this address.
    owner_email: str | None
    provider: AgentProvider
    mode: AgentMode
    # The agent's own capabilities; a call may use those its delegated person's role allows too.
    capabilities: list[str]
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


def _agent_out(record: McpToken, origin: str) -> McpAgentOut:
    return McpAgentOut(
        id=record.id,
        label=record.label,
        origin=origin,
        owner_email=record.owner_email,
        provider=record.provider,
        mode=record.mode,
        capabilities=list(record.capabilities),
        created_at=record.created_at,
        last_used_at=record.last_used_at,
        revoked_at=record.revoked_at,
    )


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
    return [_agent_out(record, "oauth" if record.id in oauth_ids else "cli") for record in records]


class McpAgentInput(BaseModel):
    label: str = Field(min_length=1, max_length=LABEL_MAX_LENGTH)
    provider: AgentProvider = AgentProvider.OTHER
    mode: AgentMode = AgentMode.WORKER
    # None: the defaults of `mode`.
    capabilities: list[str] | None = None


class McpAgentCreated(BaseModel):
    agent: McpAgentOut
    # Shown once: only its hash is stored.
    token: str


@router.post("/mcp/agents", status_code=status.HTTP_201_CREATED)
def create_mcp_agent(body: McpAgentInput, auth: AuthDep, session: SessionDep) -> McpAgentCreated:
    """« Créer un jeton »: a bearer token acting for the signed-in person, with the chosen mode
    and capabilities (never more than that person's role allows)."""
    with business_errors():
        token, record = mcp_tokens.create_for(
            session,
            auth.user,
            label=body.label,
            provider=body.provider,
            mode=body.mode,
            capabilities=body.capabilities,
        )
    session.refresh(record)
    return McpAgentCreated(agent=_agent_out(record, "cli"), token=token)


@router.post("/mcp/agents/{agent_id}/revoke")
def revoke_mcp_agent(agent_id: uuid.UUID, session: SessionDep, actor: CurrentActor) -> McpAgentOut:
    """« Révoquer »: the agent can no longer call `/mcp`, its OAuth tokens included."""
    try:
        record = oauth.revoke_agent(session, agent_id)
    except oauth.OAuthError:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, {"code": "not_found", "message": "Unknown agent."}
        ) from None
    return _agent_out(record, "oauth" if oauth.is_oauth_agent(session, record.id) else "cli")


class McpCallOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    # Who asked: the e-mail of the person the agent acts for (None: a token without owner).
    user_email: str | None
    agent: str
    agent_id: uuid.UUID | None
    tool: str
    arguments: Any
    # `ok`, `refused` (the tool answered an error: `error_code`, `error_message`) or `error`.
    outcome: str
    error_code: str | None
    error_message: str | None
    duration_ms: int


class McpCallsOut(BaseModel):
    calls: list[McpCallOut]
    emails: list[str]
    tools: list[str]
    has_more: bool


@router.get("/mcp/calls")
def mcp_call_history(
    session: SessionDep,
    email: str | None = None,
    tool: str | None = None,
    agent_id: uuid.UUID | None = None,
    before: datetime | None = None,
    limit: int = Query(default=mcp_calls.DEFAULT_PAGE, ge=1, le=mcp_calls.MAX_PAGE),
) -> McpCallsOut:
    """« Historique des appels »: who asked what on `/mcp`, newest first."""
    page = mcp_calls.history(
        session, email=email, tool=tool, token_id=agent_id, before=before, limit=limit
    )
    return McpCallsOut(
        calls=[
            McpCallOut(
                id=call.id,
                created_at=call.created_at,
                user_email=call.user_email,
                agent=call.token_label,
                agent_id=call.token_id,
                tool=call.tool,
                arguments=call.arguments,
                outcome=call.outcome,
                error_code=call.error_code,
                error_message=call.error_message,
                duration_ms=call.duration_ms,
            )
            for call in page.calls
        ],
        emails=page.emails,
        tools=page.tools,
        has_more=page.has_more,
    )
