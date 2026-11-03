"""Paramètres > MCP: what VIPER exposes to agents, with the parameters of each tool.

Read-only: the tools are code (`app.api.mcp.TOOLS`), the page only renders them. The parameter list
is digested here rather than in the browser, so the UI stays a viewer and the JSON Schema keeps a
single source.
"""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.mcp import PROTOCOL_VERSION, TOOLS

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
