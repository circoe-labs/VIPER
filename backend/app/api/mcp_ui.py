"""The UI resources of `/mcp`: the HTML templates an MCP Apps host (ChatGPT) renders next to a
tool's result. Today, one: the mission card of `viper_create_mission`.

A template is a static, self-contained HTML file (inline CSS and JS, no network access) read
from `app/api/mcp_ui_templates/`. It holds no data and no authorization: the host hands it the
tool's input and result, and every action it offers is a `tools/call` back through the host, so
`/mcp` checks the same capabilities as when the model calls the tool. A host that ignores
templates gets the same tools and the same results.
Contract: `doc/architecture/mcp-server.md` §3.12.

Keys follow the MCP Apps extension (`text/html;profile=mcp-app`, `_meta.ui.*`), plus the ChatGPT
aliases (`openai/*`) that the Apps SDK documents as still read.
"""

from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from app.services.errors import NotFoundError

MIME_TYPE = "text/html;profile=mcp-app"
_TEMPLATES = Path(__file__).with_name("mcp_ui_templates")

# The version is part of the URI: hosts cache a template by URI, so a changed card gets a new one.
MISSION_CARD_URI = "ui://viper/mission-card-v1.html"


@dataclass(frozen=True, slots=True)
class UiResource:
    uri: str
    name: str
    title: str
    description: str
    filename: str

    def meta(self) -> dict[str, Any]:
        # No `csp` domains: the card loads nothing and calls VIPER only through the host bridge.
        return {
            "ui": {"prefersBorder": True, "csp": {"connectDomains": [], "resourceDomains": []}},
            "openai/widgetPrefersBorder": True,
            "openai/widgetDescription": self.description,
        }

    def listing(self) -> dict[str, Any]:
        """The `resources/list` entry."""
        return {
            "uri": self.uri,
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "mimeType": MIME_TYPE,
            "_meta": self.meta(),
        }


RESOURCES: tuple[UiResource, ...] = (
    UiResource(
        uri=MISSION_CARD_URI,
        name="viper-mission-card",
        title="Mission VIPER",
        description=(
            "Carte de la mission VIPER : l'interprétation de la demande (type, zone, période, "
            "résultat, maximum, récurrence, agent), modifiable, avec « Créer », « Créer et "
            "lancer » et « Modifier les paramètres »."
        ),
        filename="mission_card.html",
    ),
)
_BY_URI = {resource.uri: resource for resource in RESOURCES}


@cache
def _html(filename: str) -> str:
    return (_TEMPLATES / filename).read_text(encoding="utf-8")


def list_resources() -> list[dict[str, Any]]:
    return [resource.listing() for resource in RESOURCES]


def read_resource(uri: Any) -> dict[str, Any]:
    """The `resources/read` result for `uri`; `NotFoundError` when VIPER serves no such template."""
    resource = _BY_URI.get(uri) if isinstance(uri, str) else None
    if resource is None:
        raise NotFoundError(f"Unknown resource {uri!r}.")
    return {
        "contents": [
            {
                "uri": resource.uri,
                "mimeType": MIME_TYPE,
                "text": _html(resource.filename),
                "_meta": resource.meta(),
            }
        ]
    }


def _template(uri: str) -> dict[str, Any]:
    return {"ui": {"resourceUri": uri}, "openai/outputTemplate": uri}


# The tool whose result the host renders with the card (`tools/list` `_meta`).
_RENDER_TOOLS: dict[str, dict[str, Any]] = {
    "viper_create_mission": {
        **_template(MISSION_CARD_URI),
        "openai/widgetAccessible": True,
        "openai/toolInvocation/invoking": "Création de la mission…",
        "openai/toolInvocation/invoked": "Réponse de VIPER reçue.",
    },
}
# The tools the card calls itself. MCP Apps lets the card call any tool whose `ui.visibility`
# includes "app" (the default); ChatGPT's older bridge also wants `openai/widgetAccessible`.
_CARD_TOOLS = ("viper_mission_options", "viper_update_mission", "viper_run_mission")


def tool_meta(name: str) -> dict[str, Any] | None:
    """The `_meta` of tool `name` in `tools/list`, or `None` when it has none."""
    if name in _RENDER_TOOLS:
        return _RENDER_TOOLS[name]
    if name in _CARD_TOOLS:
        return {"openai/widgetAccessible": True}
    return None


def result_meta(name: str) -> dict[str, Any] | None:
    """The `_meta` added to every result of tool `name` (refusals included, so the card can show
    a validation error), or `None`."""
    if name in _RENDER_TOOLS:
        return _template(MISSION_CARD_URI)
    return None
