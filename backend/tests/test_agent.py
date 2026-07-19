import pytest

from app.agent.service import AgentService
from app.models import AgentChatRequest, MarketContextResponse, SecurityContext


class FakeMarket:
    async def context(self, query, count):
        return MarketContextResponse(
            status="ok",
            source="test-provider",
            asOf="2026-07-17T10:00:00+08:00",
            marketStatus="trading",
            securities=[SecurityContext(
                code="SH.600519",
                name="贵州茅台",
                market="沪市",
                price=1500,
                dataTime="2026-07-17T10:00:00+08:00",
                marketStatus="trading",
                profile={"industry": "白酒"},
                financial={"reportDate": "2026-03-31", "roe": 12.5},
                technical={"return20d": 3.2, "ma20": 1488},
                dataSources={"snapshot": "akshare-eastmoney", "financial": "akshare-eastmoney"},
            )],
        )


class FakeModel:
    def __init__(self):
        self.messages = []

    async def stream(self, messages):
        self.messages = messages
        yield "结论"

    async def close(self):
        return None


@pytest.mark.asyncio
async def test_stock_agent_injects_market_and_streams_events():
    model = FakeModel()
    service = AgentService(FakeMarket(), model)
    request = AgentChatRequest(
        requestId="req-1",
        roleId="stock_expert",
        text="分析 600519",
        memories=["风险偏好较低"],
    )
    events = [event async for event in service.stream(request)]

    event_names = [event.splitlines()[0].removeprefix("event: ") for event in events]
    assert event_names.index("research") < event_names.index("delta") < event_names.index("done")
    assert any("event: research" in event for event in events)
    assert any("event: reasoning" in event and "快照" in event for event in events)
    assert any("event: reasoning" in event and "最大回撤" in event for event in events)
    assert any("event: delta" in event and "结论" in event for event in events)
    system = model.messages[0]["content"]
    assert "test-provider" in system
    assert "akshare-eastmoney" in system
    assert "return20d" in system
    assert "风险偏好较低" in system
    assert "不得承诺收益" in system
    assert "不得套用固定章节" in system


class NoCallModel(FakeModel):
    async def stream(self, messages):
        raise AssertionError("out-of-scope request must not call the model")
        yield ""


@pytest.mark.asyncio
async def test_stock_agent_rejects_out_of_scope_without_model_call():
    model = NoCallModel()
    service = AgentService(FakeMarket(), model)
    events = [event async for event in service.stream(AgentChatRequest(
        requestId="req-weather",
        roleId="stock_expert",
        text="今天天气怎么样",
    ))]

    assert not any("event: reasoning" in event for event in events)
    assert any("event: result" in event and "请切换到麦麦" in event for event in events)
