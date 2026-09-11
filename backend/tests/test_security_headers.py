"""Security headers on every API response; no submitted or bound value echoed in a refusal or in a
database error message (Task 20)."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.api.security_headers import SECURITY_HEADERS

SYNTHETIC_ADDRESS = "jean.cache@example.com"


def assert_security_headers(response_headers: dict[str, str] | object) -> None:
    for name, value in SECURITY_HEADERS.items():
        assert response_headers[name] == value, name  # type: ignore[index]


@pytest.mark.parametrize(
    ("signed_in", "path"),
    [
        (False, "/api/health"),
        (False, "/api/home"),
        (True, "/api/home"),
        (True, "/api/explorer/tables/companies/export.csv"),
        (True, "/api/exports/workbook"),
    ],
)
def test_every_api_response_carries_the_security_headers(
    client: TestClient, anonymous_client: TestClient, signed_in: bool, path: str
) -> None:
    response = (client if signed_in else anonymous_client).get(path)

    assert response.status_code == (200 if signed_in or path == "/api/health" else 401)
    assert_security_headers(response.headers)


def test_a_refused_write_carries_them_too(client: TestClient) -> None:
    response = client.post("/api/companies", json={"display_name": ""})

    assert response.status_code == 422
    assert_security_headers(response.headers)


def test_database_errors_do_not_quote_the_bound_values(db_session: Session) -> None:
    with pytest.raises(DBAPIError) as error:
        db_session.execute(
            text("SELECT 1 / 0 WHERE CAST(:address AS text) <> ''"), {"address": SYNTHETIC_ADDRESS}
        )

    assert "division by zero" in str(error.value)
    assert SYNTHETIC_ADDRESS not in str(error.value)


def test_a_malformed_request_is_refused_without_echoing_what_was_sent(
    anonymous_client: TestClient, client: TestClient
) -> None:
    password = {"valeur": "mot-de-passe-synthetique-secret"}
    login = anonymous_client.post(
        "/api/auth/login", json={"email": SYNTHETIC_ADDRESS, "password": password}
    )
    create = client.post("/api/companies", json={"display_name": {"nom": "Transports Secret"}})

    for response in (login, create):
        assert response.status_code == 422
        assert all("input" not in error and error["loc"] for error in response.json()["detail"])
    assert "mot-de-passe-synthetique-secret" not in login.text
    assert "Transports Secret" not in create.text
