from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app


def test_health_reports_ok_when_database_is_reachable(client: TestClient) -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok"}


def test_health_reports_unavailable_database_with_503() -> None:
    unreachable = "postgresql+psycopg://viper:viper@127.0.0.1:1/viper_test"
    with TestClient(create_app(Settings(database_url=unreachable))) as client:
        response = client.get("/api/health")

    assert response.status_code == 503
    assert response.json() == {"status": "degraded", "database": "unavailable"}


def test_openapi_schema_is_served_under_api_prefix(client: TestClient) -> None:
    response = client.get("/api/openapi.json")

    assert response.status_code == 200
    assert "/api/health" in response.json()["paths"]
