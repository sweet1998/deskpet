import pytest

from app.models import ChatMessage, MarketContextResponse, ResearchPrepareRequest, SecurityContext
from app.research import ResearchService


def security(code, name):
    return SecurityContext(
        code=code,
        name=name,
        market="沪市" if code.startswith("SH") else "深市",
        price=100,
        changePercent=1.5,
        dataTime="2026-07-17T15:00:00+08:00",
        peRatio=20,
        pbRatio=4,
        marketCap=100_000_000_000,
        dailyBars=[
            {"time": "2026-07-16", "close": 98},
            {"time": "2026-07-17", "close": 100},
        ],
        financial={
            "reportDate": "2026-03-31",
            "revenueYoY": 8.1,
            "netProfitYoY": 6.2,
            "roe": 12.5,
            "debtRatio": 18,
            "operatingCashFlowPerShare": 2.3,
        },
        dataSources={"snapshot": "fake"},
        technical={
            "return20d": 3.2,
            "ma20": 97.5,
            "volatility20d": 18.4,
            "maxDrawdown60d": -8.6,
        },
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

    async def resolve_sector_names(self, names):
        self.calls.append(("sector-theme-resolve", "、".join(names)))
        return [
            {"kind": "industry", "code": f"BK{index:04d}", "name": name}
            for index, name in enumerate(names, start=1)
        ]

    async def sector_context(self, category, code, name):
        self.calls.append(("sector", name))
        return {
            "kind": "sector",
            "status": "ok",
            "code": code,
            "name": name,
            "snapshot": {"changePercent": 1.8},
            "dailyBars": [{"time": "2026-07-17", "close": 100}],
            "technical": {"return20d": 4.2},
            "breadth": {"advancers": 8, "decliners": 4},
            "leaders": [{"name": "贵州茅台", "changePercent": 2.1}],
            "warnings": [],
        }

    async def scan_sectors(self, limit, window_days, progress=None):
        self.calls.append(("sector-scan", f"{limit}:{window_days}"))
        if progress:
            await progress("已获取 90 个行业板块的行情快照")
            await progress("已完成 15/15 个候选板块的历史趋势计算")
            await progress("趋势排名已生成，当前前列候选为：白酒")
        return {
            "kind": "sector_scan",
            "status": "ok",
            "universe": "industry",
            "criteria": {
                "windowDays": 60,
                "universeCount": 90,
                "scannedCount": 15,
                "strictMatchCount": 3,
            },
            "sectors": [{
                "rank": 1,
                "category": "industry_ths",
                "code": "881273",
                "name": "白酒",
                "matchLevel": "strict",
                "snapshot": {"advancers": 18, "decliners": 2},
                "technical": {"return20d": 8.7, "return60d": 12.4, "maxDrawdown60d": -6.1},
            }],
            "warnings": [],
        }

    async def index_context(self, code, name, category):
        self.calls.append(("index", name))
        return {
            "kind": "index",
            "status": "ok",
            "name": name,
            "snapshot": {"price": 4200, "changePercent": -0.8},
            "dailyBars": [{"time": "2026-07-17", "close": 4200}],
            "technical": {"return20d": -3.4, "volatility20d": 16.2, "maxDrawdown60d": -8},
            "warnings": [],
        }

    async def market_overview(self):
        self.calls.append(("market", "A股"))
        return {
            "kind": "market",
            "status": "ok",
            "advancers": 3000,
            "decliners": 2000,
            "medianChangePercent": 0.4,
            "totalAmount": 1_200_000_000_000,
            "leaders": [{"name": "贵州茅台"}],
            "warnings": [],
        }


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
    assert any("近20日 3.20%" in item for item in trend.thoughts)
    assert any("营收同比 8.10%" in item for item in fundamental.thoughts)
    assert any("PE 20.00" in item for item in valuation.thoughts)
    assert all("dailyBars" not in str(item.context) for item in (trend, fundamental, valuation, comparison))
    assert trend.context["market"]["securities"][0]["history"]["points"] == 2


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
    assert any("8 家上涨、4 家下跌" in thought for thought in sector.thoughts)
    assert "dailyBars" not in str(sector.context)
    assert index_quote.intent == "index"
    assert index_quote.requiresResearch is False
    assert index_quote.thoughts == []
    assert index_research.requiresResearch is True
    assert any("60日最大回撤 -8.00%" in thought for thought in index_research.thoughts)


@pytest.mark.asyncio
async def test_technology_theme_aggregates_standard_sectors_without_clarification():
    market = FakeResearchMarket()
    progress = []

    async def report(text):
        progress.append(text)

    result = await ResearchService(market).prepare(ResearchPrepareRequest(
        text="最近科技板块怎么样",
        roleId="stock_expert",
    ), progress=report)

    assert result.scope == "in_scope"
    assert result.intent == "sector"
    assert result.targetKind == "sector"
    assert [item.name for item in result.targets] == [
        "半导体", "软件开发", "IT服务Ⅱ", "通信设备", "消费电子",
    ]
    assert result.context["kind"] == "sector_group"
    assert any("正在把科技主题拆分" in item for item in progress)
    assert any("半导体板块" in item for item in progress)
    assert result.reply is None


@pytest.mark.asyncio
@pytest.mark.parametrize("query", [
    "最近什么板块有逐步上涨的趋势",
    "最近什么行情有上涨趋势",
    "近期哪些方向在走强",
])
async def test_sector_scan_question_uses_ranked_workflow_without_clarification(query):
    result, market = await prepare(query)

    assert result.scope == "in_scope"
    assert result.intent == "sector_scan"
    assert result.requiresResearch is True
    assert result.targets[0].name == "白酒"
    assert any("扫描 90 个行业" in thought for thought in result.thoughts)
    assert any("近20日 8.70%" in thought for thought in result.thoughts)
    assert ("sector-scan", "5:60") in market.calls
    assert not any(kind == "sector-resolve" for kind, _ in market.calls)


@pytest.mark.asyncio
async def test_generic_sector_scan_does_not_override_explicit_security_or_index():
    security_result, _ = await prepare("600519 最近什么行情有上涨趋势")
    index_result, _ = await prepare("沪深300 最近什么行情有上涨趋势")

    assert security_result.intent == "security_trend"
    assert index_result.intent == "index"


@pytest.mark.asyncio
async def test_sector_scan_reports_progress_before_returning_result():
    market = FakeResearchMarket()
    progress = []

    async def report(text):
        progress.append(text)

    result = await ResearchService(market).prepare(ResearchPrepareRequest(
        text="最近什么行情有上涨趋势",
        roleId="stock_expert",
    ), progress=report)

    assert result.intent == "sector_scan"
    assert progress == [
        "正在读取全市场行业快照",
        "已获取 90 个行业板块的行情快照",
        "已完成 15/15 个候选板块的历史趋势计算",
        "趋势排名已生成，当前前列候选为：白酒",
        "#1 白酒（符合严格条件）：近20日 8.70%，近60日 12.40%，最大回撤 -6.10%，当日 18 家上涨/2 家下跌",
    ]


@pytest.mark.asyncio
async def test_clarification_does_not_emit_research_progress():
    market = FakeResearchMarket()
    progress = []

    async def report(text):
        progress.append(text)

    result = await ResearchService(market).prepare(ResearchPrepareRequest(
        text="最近走势怎么样",
        roleId="stock_expert",
    ), progress=report)

    assert result.intent == "clarification"
    assert progress == []


@pytest.mark.asyncio
async def test_follow_up_inherits_previous_security_target():
    result, market = await prepare("那它的风险呢", [
        ChatMessage(role="user", content="分析 600519"),
        ChatMessage(role="assistant", content="贵州茅台近期表现偏震荡。"),
    ])
    assert result.intent == "security_trend"
    assert result.targets[0].code == "SH.600519"
    assert any("600519" in query for kind, query in market.calls if kind == "security")
