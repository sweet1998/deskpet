import pytest

from app.models import ChatMessage, MarketContextResponse, ResearchPrepareRequest, SecurityContext, StockRouteHint
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


async def prepare(text, history=None, route=None):
    market = FakeResearchMarket()
    result = await ResearchService(market).prepare(ResearchPrepareRequest(
        text=text,
        roleId="stock_expert",
        history=history or [],
        routeHint=route,
    ))
    return result, market


@pytest.mark.asyncio
async def test_high_confidence_model_route_resolves_only_terms_present_in_history():
    result, market = await prepare("它最近表现怎么样", [
        ChatMessage(role="user", content="看看白酒板块"),
        ChatMessage(role="assistant", content="白酒板块今天震荡。"),
    ], StockRouteHint(
        scope="in_scope",
        intent="sector",
        relation="followup",
        targetKind="sector",
        targetTerms=["白酒", "新能源"],
        requiresResearch=True,
        confidence=0.96,
    ))

    assert result.intent == "sector"
    assert result.targets[0].name == "白酒"
    assert ("sector", "白酒") in market.calls
    assert all("新能源" not in query for _, query in market.calls)


@pytest.mark.asyncio
async def test_constituent_followup_overrides_incorrect_model_out_of_scope_route():
    result, market = await prepare("上涨的是哪几家", [
        ChatMessage(role="user", content="最近白酒行情怎么样 为什么"),
        ChatMessage(role="assistant", content="白酒板块有 8 家上涨、4 家下跌。"),
    ], StockRouteHint(
        scope="out_of_scope",
        intent="out_of_scope",
        relation="standalone",
        targetKind="none",
        requiresResearch=False,
        confidence=0.98,
    ))

    assert result.scope == "in_scope"
    assert result.intent == "sector_snapshot"
    assert result.targets[0].name == "白酒"
    assert ("sector", "白酒") in market.calls


@pytest.mark.asyncio
async def test_low_confidence_model_route_falls_back_to_deterministic_router():
    result, _ = await prepare("它最近表现怎么样", route=StockRouteHint(
        scope="in_scope",
        intent="sector",
        relation="followup",
        targetKind="sector",
        targetTerms=["白酒"],
        requiresResearch=True,
        confidence=0.4,
    ))

    assert result.intent == "clarification"


@pytest.mark.asyncio
async def test_explicit_security_code_takes_priority_over_model_out_of_scope_hint():
    result, _ = await prepare("600519 现在多少钱", route=StockRouteHint(
        scope="out_of_scope",
        intent="out_of_scope",
        relation="standalone",
        targetKind="none",
        confidence=0.99,
    ))

    assert result.scope == "in_scope"
    assert result.intent == "security_quote"


@pytest.mark.asyncio
async def test_new_topic_model_route_cannot_reuse_target_term_from_old_history():
    result, market = await prepare("换个话题，看看别的", [
        ChatMessage(role="user", content="分析白酒板块"),
        ChatMessage(role="assistant", content="白酒板块近期震荡。"),
    ], StockRouteHint(
        scope="needs_clarification",
        intent="clarification",
        relation="new_topic",
        targetKind="none",
        targetTerms=["白酒"],
        confidence=0.95,
    ))

    assert result.intent == "clarification"
    assert all("白酒" not in query for _, query in market.calls)


@pytest.mark.asyncio
async def test_model_answer_followup_route_takes_priority_over_explicit_code():
    result, market = await prepare("为什么你说 600519 风险较高", route=StockRouteHint(
        scope="in_scope",
        intent="answer_followup",
        relation="answer_explanation",
        targetKind="knowledge",
        confidence=0.94,
    ))

    assert result.intent == "answer_followup"
    assert market.calls == []


@pytest.mark.asyncio
async def test_model_can_classify_stock_term_not_in_static_education_dictionary():
    result, market = await prepare("股票里的 Alpha 是什么", route=StockRouteHint(
        scope="in_scope",
        intent="education",
        relation="standalone",
        targetKind="knowledge",
        confidence=0.93,
    ))

    assert result.intent == "education"
    assert market.calls == []


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
@pytest.mark.parametrize("query", [
    "你对什么领域很了解",
    "你擅长什么",
    "你擅长干什么",
    "你能帮我做什么",
    "你可以干什么",
    "你能干什么",
    "你是谁",
])
async def test_role_capability_questions_skip_market_data(query):
    result, market = await prepare(query)

    assert result.scope == "in_scope"
    assert result.intent == "role_capability"
    assert result.requiresResearch is False
    assert result.reply is None
    assert market.calls == []


@pytest.mark.asyncio
async def test_model_role_capability_route_covers_phrasing_regex_misses():
    result, market = await prepare("你平时都能陪我聊些啥呀", route=StockRouteHint(
        scope="in_scope",
        intent="role_capability",
        relation="standalone",
        targetKind="knowledge",
        confidence=0.95,
    ))

    assert result.scope == "in_scope"
    assert result.intent == "role_capability"
    assert result.requiresResearch is False
    assert result.reply is None
    assert market.calls == []


@pytest.mark.asyncio
async def test_high_confidence_semantic_route_is_not_vetoed_by_keyword_blacklist():
    result, market = await prepare("解释量化编程在 A 股研究中的作用", route=StockRouteHint(
        scope="in_scope",
        intent="education",
        relation="standalone",
        targetKind="knowledge",
        confidence=0.96,
    ))

    assert result.scope == "in_scope"
    assert result.intent == "education"
    assert market.calls == []


@pytest.mark.asyncio
async def test_out_of_scope_preparation_does_not_hard_code_the_reply():
    result, market = await prepare("你能告诉我怎么去北京吗", route=StockRouteHint(
        scope="out_of_scope",
        intent="out_of_scope",
        relation="new_topic",
        targetKind="none",
        confidence=0.98,
    ))

    assert result.scope == "out_of_scope"
    assert result.reply is None
    assert market.calls == []


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
async def test_today_sector_and_market_queries_use_simple_snapshots():
    sector, sector_market = await prepare("今天白酒行情怎么样")
    market, market_service = await prepare("今天行情怎么样")

    assert sector.scope == "in_scope"
    assert sector.intent == "sector_snapshot"
    assert sector.targetKind == "sector"
    assert sector.targets[0].name == "白酒"
    assert sector.requiresResearch is False
    assert sector.thoughts == []
    assert ("sector", "白酒") in sector_market.calls

    assert market.scope == "in_scope"
    assert market.intent == "market_snapshot"
    assert market.targetKind == "market"
    assert market.requiresResearch is False
    assert market.thoughts == []
    assert ("market", "A股") in market_service.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("query", [
    "今天盘面如何",
    "A股今天表现怎么样",
    "今天股市涨跌情况",
    "今天行情怎样",
    "今天市场什么情况",
    "大A今天咋样",
    "两市今天红还是绿",
    "今天盘面强不强",
    "今天行情好吗",
    "A股今天还好吗",
    "大盘今天咋回事",
    "两市今天有啥变化",
    "今天赚钱效应好不好",
])
async def test_colloquial_market_snapshot_queries_default_to_a_share(query):
    result, _ = await prepare(query)

    assert result.intent == "market_snapshot"
    assert result.targetKind == "market"
    assert result.requiresResearch is False


@pytest.mark.asyncio
@pytest.mark.parametrize("query", [
    "什么是 PEG",
    "MACD 怎么理解",
    "解释一下集合竞价",
    "PE 和 PB 有什么区别",
    "融资融券是什么意思",
    "市盈率高代表什么",
    "为什么会涨停",
    "怎么理解 T+1",
    "新手怎么选股",
])
async def test_colloquial_education_queries_do_not_fetch_market_data(query):
    result, market = await prepare(query)

    assert result.scope == "in_scope"
    assert result.intent == "education"
    assert result.requiresResearch is False
    assert market.calls == []


@pytest.mark.asyncio
async def test_target_first_routing_distinguishes_sector_and_security_snapshots():
    sector, _ = await prepare("白酒板块今天表现如何")
    security_result, _ = await prepare("今天茅台行情怎么样")
    sector_research, _ = await prepare("为什么今天白酒大涨")

    assert sector.intent == "sector_snapshot"
    assert sector.targets[0].name == "白酒"
    assert security_result.intent == "security_quote"
    assert security_result.targets[0].code == "SH.600519"
    assert sector_research.intent == "sector"
    assert sector_research.requiresResearch is True


@pytest.mark.asyncio
async def test_elliptical_today_follow_up_inherits_previous_sector():
    result, _ = await prepare("那今天呢", [
        ChatMessage(role="user", content="白酒最近趋势怎么样"),
        ChatMessage(role="assistant", content="白酒板块近期波动较大。"),
    ])

    assert result.intent == "sector_snapshot"
    assert result.targets[0].name == "白酒"
    assert result.requiresResearch is False


@pytest.mark.asyncio
async def test_recent_market_query_keeps_research_workflow():
    result, _ = await prepare("最近大盘为什么走弱")

    assert result.intent == "market"
    assert result.requiresResearch is True
    assert any("全市场" in thought for thought in result.thoughts)


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
    "人工智能板块最近怎么样",
    "AI 方向后市怎么看",
    "新能源最近还好吗",
    "医药板块接下来怎么看",
    "金融板块最近走势",
])
async def test_common_sector_themes_route_to_group_research(query):
    result, _ = await prepare(query)

    assert result.scope == "in_scope"
    assert result.intent == "sector"
    assert result.targetKind == "sector"
    assert result.requiresResearch is True


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


@pytest.mark.asyncio
async def test_implicit_follow_up_inherits_security_without_pronouns():
    result, market = await prepare("为什么最近跌这么厉害", [
        ChatMessage(role="user", content="分析 600519"),
        ChatMessage(role="assistant", content="贵州茅台近期表现偏震荡。"),
    ])

    assert result.intent == "security_trend"
    assert result.targets[0].code == "SH.600519"
    assert any("600519" in query for kind, query in market.calls if kind == "security")


@pytest.mark.asyncio
async def test_answer_explanation_follow_up_uses_history_without_resolving_a_new_target():
    result, market = await prepare("为什么没有覆盖消息面", [
        ChatMessage(role="user", content="今天半导体板块怎么样"),
        ChatMessage(
            role="assistant",
            content="我手上的数据没有覆盖消息面，没法确认具体催化。",
        ),
    ])

    assert result.scope == "in_scope"
    assert result.intent == "answer_followup"
    assert result.requiresResearch is False
    assert result.targetKind == "knowledge"
    assert result.thoughts == []
    assert market.calls == []


@pytest.mark.asyncio
async def test_data_coverage_question_remains_in_scope_when_client_history_is_missing():
    result, market = await prepare("为什么你手上的数据没有覆盖消息面")

    assert result.scope == "in_scope"
    assert result.intent == "answer_followup"
    assert market.calls == []


@pytest.mark.asyncio
async def test_implicit_follow_up_inherits_previous_sector():
    result, _ = await prepare("为什么最近跌这么厉害", [
        ChatMessage(role="user", content="白酒板块最近怎么样"),
        ChatMessage(role="assistant", content="白酒板块近期走弱。"),
    ])

    assert result.intent == "sector"
    assert result.targets[0].name == "白酒"


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["要", "可以，查一下", "继续看看", "展开说说"])
async def test_short_confirmation_inherits_previous_sector(query):
    result, _ = await prepare(query, [
        ChatMessage(role="user", content="今天科技板块行情怎么样"),
        ChatMessage(role="assistant", content="要不要继续看看板块里的核心个股近期表现？"),
    ])

    assert result.scope == "in_scope"
    assert result.intent == "sector"
    assert result.targetKind == "sector"
    assert {target.name for target in result.targets} == {
        "半导体", "软件开发", "IT服务Ⅱ", "通信设备", "消费电子",
    }


@pytest.mark.asyncio
async def test_explicit_new_topic_does_not_inherit_previous_target():
    result, market = await prepare("换个话题，为什么最近跌这么厉害", [
        ChatMessage(role="user", content="分析 600519"),
        ChatMessage(role="assistant", content="贵州茅台近期表现偏震荡。"),
    ])

    assert result.intent == "clarification"
    assert all("600519" not in query for _, query in market.calls)


@pytest.mark.asyncio
async def test_explicit_current_target_takes_priority_over_conversation_memory():
    result, market = await prepare("五粮液为什么最近跌", [
        ChatMessage(role="user", content="分析 600519"),
        ChatMessage(role="assistant", content="贵州茅台近期表现偏震荡。"),
    ])

    assert result.targets[0].code == "SZ.000858"
    assert all("600519" not in query for kind, query in market.calls if kind == "security")


@pytest.mark.asyncio
async def test_follow_up_uses_the_most_recent_explicit_target_only():
    result, market = await prepare("那它的风险呢", [
        ChatMessage(role="user", content="先看 600519"),
        ChatMessage(role="assistant", content="贵州茅台近期偏震荡。"),
        ChatMessage(role="user", content="再看 000858"),
        ChatMessage(role="assistant", content="五粮液近期波动较大。"),
    ])

    assert result.intent == "security_trend"
    assert result.targets[0].code == "SZ.000858"
    assert all("600519" not in query for kind, query in market.calls if kind == "security")


@pytest.mark.asyncio
@pytest.mark.parametrize("query, expected_name", [
    ("沪指今天怎么样", "上证指数"),
    ("上证最近为什么走弱", "上证指数"),
    ("深成指当前点位", "深证成指"),
    ("创业板指数最近走势", "创业板指"),
])
async def test_common_index_aliases(query, expected_name):
    result, _ = await prepare(query)

    assert result.intent == "index"
    assert result.targets[0].name == expected_name


@pytest.mark.asyncio
@pytest.mark.parametrize("query", [
    "市盈率怎么算",
    "ROE 有什么用",
    "量价关系是什么意思",
    "PE 高好还是低好",
])
async def test_more_stock_education_phrasings_skip_market(query):
    result, market = await prepare(query)

    assert result.intent == "education"
    assert result.requiresResearch is False
    assert market.calls == []
