from fastapi.testclient import TestClient

from app.main import app


def test_health_endpoint():
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["service"] == "deskpet-backend"


def test_request_validation_rejects_long_daily_count():
    with TestClient(app) as client:
        response = client.post("/v1/market/context", json={
            "query": "600519",
            "dailyCount": 121,
        })
    assert response.status_code == 422
