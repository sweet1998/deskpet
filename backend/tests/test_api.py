from dataclasses import replace
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from app import main as main_module
from app.main import app
from app.models import MarketContextResponse


class StreamingAgent:
    def __init__(self):
        self.chat_request = None
        self.prepare_request = None

    async def stream(self, request):
        self.chat_request = request
        yield 'event: state\ndata: {"state":"thinking"}\n\n'
        yield 'event: delta\ndata: {"text":"流式回答"}\n\n'
        yield 'event: done\ndata: {}\n\n'

    async def stream_prepare(self, request):
        self.prepare_request = request
        yield 'event: reasoning\ndata: {"text":"识别白酒板块"}\n\n'
        yield 'event: result\ndata: {"scope":"in_scope"}\n\n'


def test_health_endpoint():
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["service"] == "deskpet-backend"


def test_protected_endpoint_requires_configured_bearer_token(monkeypatch):
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, api_token="desktop-secret"))
    with TestClient(app) as client:
        monkeypatch.setattr(
            client.app.state.market,
            "context",
            AsyncMock(return_value=MarketContextResponse(status="ok", source="test", securities=[])),
        )
        denied = client.post("/v1/market/context", json={"query": "600519", "dailyCount": 120})
        authorized = client.post(
            "/v1/market/context",
            json={"query": "600519", "dailyCount": 120},
            headers={"Authorization": "Bearer desktop-secret"},
        )
    assert denied.status_code == 401
    assert authorized.status_code == 200


def test_request_validation_rejects_long_daily_count():
    with TestClient(app) as client:
        response = client.post("/v1/market/context", json={
            "query": "600519",
            "dailyCount": 121,
        })
    assert response.status_code == 422


def test_sector_scan_validation_rejects_large_limit():
    with TestClient(app) as client:
        response = client.post("/v1/market/sector-scan", json={"limit": 11})
    assert response.status_code == 422


def test_market_health_reports_degraded_cached_data(monkeypatch):
    monkeypatch.setattr(main_module, "settings", replace(main_module.settings, api_token="desktop-secret"))
    with TestClient(app) as client:
        monkeypatch.setattr(
            client.app.state.market,
            "market_overview",
            AsyncMock(return_value={
                "status": "ok",
                "source": "tencent",
                "stale": True,
                "warnings": ["已使用本机最近一次成功缓存"],
            }),
        )
        response = client.get(
            "/v1/market/health",
            headers={"Authorization": "Bearer desktop-secret"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "status": "degraded",
        "provider": "akshare",
        "fallbackProvider": "tencent",
        "source": "tencent",
        "stale": True,
        "asOf": None,
        "warnings": ["已使用本机最近一次成功缓存"],
        "error": None,
    }


def test_agent_chat_endpoint_preserves_sse_order_and_headers():
    fake = StreamingAgent()
    with TestClient(app) as client:
        original = client.app.state.agent
        client.app.state.agent = fake
        try:
            response = client.post("/v1/agent/chat", json={
                "requestId": "req-http-stream",
                "roleId": "default",
                "text": "你好",
            })
        finally:
            client.app.state.agent = original

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    assert response.headers["x-request-id"] == "req-http-stream"
    assert response.text.index("event: state") < response.text.index("event: delta") < response.text.index("event: done")
    assert "流式回答" in response.text
    assert fake.chat_request.requestId == "req-http-stream"


def test_agent_chat_endpoint_accepts_a_bounded_image():
    fake = StreamingAgent()
    with TestClient(app) as client:
        original = client.app.state.agent
        client.app.state.agent = fake
        try:
            response = client.post("/v1/agent/chat", json={
                "requestId": "req-http-image",
                "roleId": "default",
                "text": "分析截图",
                "image": {"mimeType": "image/png", "base64": "ZmFrZS1wbmc="},
            })
        finally:
            client.app.state.agent = original

    assert response.status_code == 200
    assert fake.chat_request.image.mimeType == "image/png"
    assert fake.chat_request.image.base64 == "ZmFrZS1wbmc="


def test_agent_chat_endpoint_rejects_invalid_image_data():
    with TestClient(app) as client:
        response = client.post("/v1/agent/chat", json={
            "requestId": "req-invalid-image",
            "roleId": "default",
            "text": "分析截图",
            "image": {"mimeType": "image/png", "base64": "not-base64"},
        })

    assert response.status_code == 422


def test_research_prepare_stream_endpoint_returns_reasoning_before_result():
    fake = StreamingAgent()
    with TestClient(app) as client:
        original = client.app.state.agent
        client.app.state.agent = fake
        try:
            response = client.post("/v1/research/prepare/stream", json={
                "roleId": "stock_expert",
                "text": "今天白酒行情怎么样",
            })
        finally:
            client.app.state.agent = original

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.text.index("event: reasoning") < response.text.index("event: result")
    assert "识别白酒板块" in response.text
    assert fake.prepare_request.text == "今天白酒行情怎么样"
