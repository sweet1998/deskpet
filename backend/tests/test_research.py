import pytest

from app.models import ChatMessage, MarketContextResponse, ResearchPrepareRequest, SecurityContext
from app.research import ResearchService


def security(code, name):
    return SecurityContext(
        code=code,
        name=name,
        market="沪市" if code.startswith("SH") else "深市",
        price=100,
        dataSources={"snapshot": "fake"},
        technical={"return20d": 3.2},
    )


class FakeResearchMarket:
    def __init__(self):
        self.calls = []

    async def context(self, query, count):
        self.calls.append(("security", query))
        securities = []
        if "600519" in query or "茅台" in query:
            securities.append(security("SH.600519", "贵州茅台"))
        if "000858" in query or "五粮液" in query:
            securities.append(security("SZ.000858", "五粮液"))
        return MarketContextResponse(
            status="ok" if securities else "no-symbol",
            source="fake",
            securities=securities,
        )

    async def resolve_securities(self, query):
        self.calls.append(("security-resolve", query))
        matches = []
        if "600519" in query or "茅台" in query:
            matches.append({"code": "SH.600519", "name": "贵州茅台", "market": "沪市"})
        if "000858" in query or "五粮液" in query:
            matches.append({"code": "SZ.000858", "name": "五粮液", "market": "深市"})
        return matches, [], []

    async def resolve_sector(self, query):
        self.calls.append(("sector-resolve", query))
        if "白酒" in query:
            return {"kind": "industry", "code": "BK0896", "name": "白酒"}, []
        return None, []

    async def sector_context(self, category, code, name):
        self.calls.append(("sector", name))
        return {
            "kind": "sector",
            "status": "ok",
            "name": name,
            "dailyBars": [{"time": "2026-07-17", "close": 100}],
            "breadth": {"advancers": 8, "decliners": 4},
            "leaders": [{"name": "贵州茅台", "changePercent": 2.1}],
            "warnings": [],
        }

    async def index_context(self, code, name, category):
        self.calls.append(("index", name))
        return {"kind": "index", "status": "ok", "name": name, "warnings": []}

    async def market_overview(self):
        self.calls.append(("market", "A股"))
        return {"kind": "market", "status": "ok", "advancers": 3000, "decliners": 2000, "warnings": []}


async def prepare(text, history=None):
    market = FakeResearchMarket()
    result = await ResearchService(market).prepare(ResearchPrepareRequest(
        text=text,
        roleId="stock_expert",
        history=history or [],
    ))
    return result, market


@pytest.mark.asyncio
async def test_out_of_scope_and_education_skip_research_data():
    weather, weather_market = await prepare("今天天气怎么样")
    recent_weather, recent_weather_market = await prepare("最近天气怎么样")
    education, education_market = await prepare("什么是市盈率")

    assert weather.scope == "out_of_scope"
    assert weather.requiresResearch is False
    assert weather.thoughts == []
    assert weather_market.calls == []
    assert recent_weather.scope == "out_of_scope"
    assert recent_weather_market.calls == []
    assert education.intent == "education"
    assert education.requiresResearch is False
    assert education_market.calls == []


@pytest.mark.asyncio
async def test_simple_quote_has_no_thought_summary():
    result, _ = await prepare("600519 现在多少钱")
    assert result.intent == "security_quote"
    assert result.requiresResearch is False
    assert result.thoughts == []


@pytest.mark.asyncio
async def test_stock_research_intents_have_distinct_thoughts():
    trend, _ = await prepare("分析 600519 近期趋势")
    fundamental, _ = await prepare("分析 600519 基本面")
    valuation, _ = await prepare("分析 600519 估值")
    comparison, _ = await prepare("对比 600519 和 000858")

    assert trend.intent == "security_trend"
    assert fundamental.intent == "fundamental"
    assert valuation.intent == "valuation"
    assert comparison.intent == "comparison"
    assert all(item.requiresResearch for item in (trend, fundamental, valuation, comparison))
    assert len({tuple(item.thoughts) for item in (trend, fundamental, valuation, comparison)}) == 4


@pytest.mark.asyncio
async def test_security_conjunction_does_not_imply_comparison():
    result, _ = await prepare("分析茅台的营收和利润")

    assert result.intent == "fundamental"


@pytest.mark.asyncio
async def test_sector_and_index_complexity_routing():
    sector, _ = await prepare("白酒最近行情怎么样")
    index_quote, _ = await prepare("沪深300当前点位")
    index_research, _ = await prepare("沪深300最近为什么走弱")

    assert sector.intent == "sector"
    assert sector.requiresResearch is True
    assert any("上涨下跌家数" in thought for thought in sector.thoughts)
    assert index_quote.intent == "index"
    assert index_quote.requiresResearch is False
    assert index_quote.thoughts == []
    assert index_research.requiresResearch is True
    assert index_research.thoughts


@pytest.mark.asyncio
async def test_follow_up_inherits_previous_security_target():
    result, market = await prepare("那它的风险呢", [
        ChatMessage(role="user", content="分析 600519"),
        ChatMessage(role="assistant", content="贵州茅台近期表现偏震荡。"),
    ])
    assert result.intent == "security_trend"
    assert result.targets[0].code == "SH.600519"
    assert any("600519" in query for kind, query in market.calls if kind == "security")
