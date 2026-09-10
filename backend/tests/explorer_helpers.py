"""Helpers for Database Explorer API tests."""

import json
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes.explorer import get_policy
from app.services.explorer.policy import ExposurePolicy

API = "/api/explorer/tables"


def condition(
    column: str, operator: str, value: Any = None, values: list[Any] | None = None
) -> dict[str, Any]:
    node: dict[str, Any] = {"type": "condition", "column": column, "operator": operator}
    if value is not None:
        node["value"] = value
    if values is not None:
        node["values"] = values
    return node


def group(*conditions: dict[str, Any], combinator: str = "and") -> dict[str, Any]:
    return {"type": "group", "combinator": combinator, "conditions": list(conditions)}


def params(
    *,
    node: dict[str, Any] | None = None,
    q: str | None = None,
    sort: list[str] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    result: dict[str, Any] = dict(extra)
    if node is not None:
        result["filter"] = json.dumps(node)
    if q is not None:
        result["q"] = q
    if sort is not None:
        result["sort"] = sort
    return result


def get_rows(client: TestClient, table: str, **kwargs: Any) -> dict[str, Any]:
    response = client.get(f"{API}/{table}/rows", params=params(**kwargs))
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def column_values(body: dict[str, Any], column: str) -> list[Any]:
    return [row["values"][column] for row in body["rows"]]


def rows_status(client: TestClient, table: str, **kwargs: Any) -> int:
    return client.get(f"{API}/{table}/rows", params=params(**kwargs)).status_code


def use_policy(client: TestClient) -> Callable[[ExposurePolicy], None]:
    app = client.app
    assert isinstance(app, FastAPI)

    def override(policy: ExposurePolicy) -> None:
        app.dependency_overrides[get_policy] = lambda: policy

    return override
