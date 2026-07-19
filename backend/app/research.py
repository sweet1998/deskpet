import re
from typing import Dict, List, Optional, Tuple

from .market.service import CODE_PATTERN, MarketService
from .models import (
    ResearchPrepareRequest,
    ResearchPrepareResponse,
    ResearchTarget,
    StockIntent,
)


OUT_OF_SCOPE_MESSAGE = "我是 A 股研究助手，只能回答个股、板块、指数和股票知识问题。其他问题请切换到麦麦。"
CLARIFY_MESSAGE = "请补充具体的六位股票代码、股票名称、板块或指数名称。"

OUT_OF_SCOPE_KEYWORDS = (
    "天气", "气温", "下雨", "空气质量", "菜谱", "做饭", "翻译", "写诗", "小说", "电影", "音乐",
    "旅游", "酒店", "机票", "星座", "编程", "程序", "vue", "react", "javascript", "python", "数据库",
    "基金", "债券", "期货", "外汇", "比特币", "加密货币", "美股", "港股",
)
EDUCATION_KEYWORDS = (
    "市盈率", "市净率", "roe", "k线", "复权", "分红", "财报", "换手率", "量比", "基本面",
    "技术面", "仓位", "止损", "估值", "涨停", "跌停", "打新", "牛市", "熊市", "成交量",
)
EDUCATION_QUESTION_WORDS = ("什么是", "是什么意思", "怎么理解", "如何理解", "含义", "区别", "解释一下")
MARKET_KEYWORDS = ("大盘", "a股市场", "全市场", "涨跌家数", "市场情绪", "市场宽度", "两市成交")
FUNDAMENTAL_KEYWORDS = ("基本面", "财报", "营收", "利润", "现金流", "roe", "负债", "成长性")
VALUATION_KEYWORDS = ("估值", "市盈率", "市净率", "pe", "pb", "贵不贵", "便宜")
TREND_KEYWORDS = (
    "趋势", "走势", "近期", "最近", "分析", "为什么", "原因", "风险", "展望", "技术面", "支撑", "压力",
)
QUOTE_KEYWORDS = ("多少钱", "当前价格", "现在价格", "股价", "涨跌幅", "现价", "当前点位", "现在点位")
REFERENCE_WORDS = ("它", "那只", "这只", "该股", "这个板块", "该板块", "这个指数", "其")
COMPARISON_WORDS = ("对比", "比较", "相比", "vs", "VS")

INDEXES: Dict[str, Dict[str, str]] = {
    "上证指数": {"name": "上证指数", "code": "sh000001", "category": "沪深重要指数"},
    "上证综指": {"name": "上证指数", "code": "sh000001", "category": "沪深重要指数"},
    "深证成指": {"name": "深证成指", "code": "sz399001", "category": "沪深重要指数"},
    "创业板指": {"name": "创业板指", "code": "sz399006", "category": "沪深重要指数"},
    "创业板": {"name": "创业板指", "code": "sz399006", "category": "沪深重要指数"},
    "科创50": {"name": "科创50", "code": "sh000688", "category": "沪深重要指数"},
    "上证50": {"name": "上证50", "code": "sh000016", "category": "沪深重要指数"},
    "沪深300": {"name": "沪深300", "code": "sh000300", "category": "沪深重要指数"},
    "中证500": {"name": "中证500", "code": "sh000905", "category": "中证系列指数"},
    "中证1000": {"name": "中证1000", "code": "sh000852", "category": "中证系列指数"},
}


def _contains(text: str, values: Tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(value.lower() in lowered for value in values)


def _index_target(text: str) -> Optional[Dict[str, str]]:
    normalized = text.replace(" ", "")
    for alias in sorted(INDEXES, key=len, reverse=True):
        if alias.lower() in normalized.lower():
            return INDEXES[alias]
    return None


def _intent_for_security(text: str, target_count: int) -> StockIntent:
    if target_count > 1 or _contains(text, COMPARISON_WORDS):
        return "comparison"
    if _contains(text, FUNDAMENTAL_KEYWORDS):
        return "fundamental"
    if _contains(text, VALUATION_KEYWORDS):
        return "valuation"
    if _contains(text, TREND_KEYWORDS) or "怎么样" in text or "如何" in text:
        return "security_trend"
    return "security_quote"


def _requires_research(intent: StockIntent, text: str) -> bool:
    if intent == "index":
        return _contains(text, TREND_KEYWORDS) or "怎么样" in text or "如何" in text
    return intent in {
        "security_trend", "fundamental", "valuation", "comparison", "sector", "market",
    }


class ResearchService:
    def __init__(self, market: MarketService):
        self.market = market

    @staticmethod
    def _reference_query(request: ResearchPrepareRequest) -> str:
        if not _contains(request.text, REFERENCE_WORDS):
            return request.text
        history = " ".join(
            item.content
            for item in request.history[-6:]
            if item.role == "user"
        )
        return f"{request.text} {history}".strip()

    @staticmethod
    def _out_of_scope(text: str) -> ResearchPrepareResponse:
        return ResearchPrepareResponse(
            scope="out_of_scope",
            intent="out_of_scope",
            requiresResearch=False,
            targetKind="none",
            reply=OUT_OF_SCOPE_MESSAGE,
        )

    @staticmethod
    def _clarification(reply: str = CLARIFY_MESSAGE) -> ResearchPrepareResponse:
        return ResearchPrepareResponse(
            scope="needs_clarification",
            intent="clarification",
            requiresResearch=False,
            targetKind="none",
            reply=reply,
        )

    @staticmethod
    def _thoughts(intent: StockIntent, targets: List[ResearchTarget], context: Dict) -> List[str]:
        names = "、".join(target.name for target in targets)
        if intent == "comparison":
            thoughts = [f"已确认对比标的：{names}", "已统一各标的行情时间、估值和财务比较口径"]
        elif intent == "fundamental":
            thoughts = [f"已获取 {names} 的公司资料和最新财务报告", "正在检查营收、利润、ROE、负债与经营现金流"]
        elif intent == "valuation":
            thoughts = [f"已获取 {names} 的 PE、PB、市值和盈利增长数据", "正在结合增长质量与近期表现评估估值位置"]
        elif intent == "security_trend":
            thoughts = [f"已获取 {names} 的实时快照和 120 日日 K", "已计算阶段收益、均线、波动率和最大回撤"]
        elif intent == "sector":
            thoughts = [f"已识别为{names}板块研究", "已获取板块走势、上涨下跌家数和领涨成分股"]
        elif intent == "index":
            thoughts = [f"已获取 {names} 的实时点位和历史走势", "已计算阶段表现、波动率和最大回撤"]
        elif intent == "market":
            thoughts = ["已获取 A 股全市场涨跌分布与成交额", "正在分析市场宽度、强弱分布和领涨方向"]
        else:
            thoughts = []
        warnings = context.get("warnings") or []
        if warnings:
            thoughts.append(f"有 {len(warnings)} 项数据缺失或使用了兜底来源")
        return thoughts

    def _security_response(
        self,
        text: str,
        market_context,
    ) -> ResearchPrepareResponse:
        targets = [
            ResearchTarget(kind="security", name=item.name, code=item.code)
            for item in market_context.securities
        ]
        intent = _intent_for_security(text, len(targets))
        requires = _requires_research(intent, text)
        context = {"kind": "security", "market": market_context.model_dump(exclude_none=True)}
        warnings = [warning for item in market_context.securities for warning in item.warnings]
        if warnings:
            context["warnings"] = warnings
        return ResearchPrepareResponse(
            scope="in_scope",
            intent=intent,
            requiresResearch=requires,
            targetKind="security",
            targets=targets,
            thoughts=self._thoughts(intent, targets, context) if requires else [],
            context=context,
        )

    async def prepare(self, request: ResearchPrepareRequest) -> ResearchPrepareResponse:
        if request.roleId != "stock_expert":
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="education",
                requiresResearch=False,
                targetKind="knowledge",
            )

        text = request.text.strip()
        reference_query = self._reference_query(request)
        has_explicit_stock_signal = bool(CODE_PATTERN.search(reference_query)) or _contains(
            reference_query,
            EDUCATION_KEYWORDS + MARKET_KEYWORDS + ("股票", "个股", "板块", "行业", "概念", "指数", "a股"),
        ) or _index_target(reference_query) is not None
        has_stock_signal = bool(CODE_PATTERN.search(reference_query)) or _contains(
            reference_query,
            EDUCATION_KEYWORDS + MARKET_KEYWORDS + TREND_KEYWORDS + QUOTE_KEYWORDS + ("股票", "个股", "板块", "行业", "概念", "指数", "a股"),
        ) or _index_target(reference_query) is not None
        if _contains(text, OUT_OF_SCOPE_KEYWORDS) and not has_explicit_stock_signal:
            return self._out_of_scope(text)

        index = _index_target(reference_query)
        if index:
            intent: StockIntent = "index"
            requires = _requires_research(intent, text)
            context = await self.market.index_context(index["code"], index["name"], index["category"])
            targets = [ResearchTarget(kind="index", name=index["name"], code=index["code"])]
            return ResearchPrepareResponse(
                scope="in_scope",
                intent=intent,
                requiresResearch=requires,
                targetKind="index",
                targets=targets,
                thoughts=self._thoughts(intent, targets, context) if requires else [],
                context=context,
            )

        if _contains(reference_query, MARKET_KEYWORDS):
            context = await self.market.market_overview()
            targets = [ResearchTarget(kind="market", name="A 股市场")]
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="market",
                requiresResearch=True,
                targetKind="market",
                targets=targets,
                thoughts=self._thoughts("market", targets, context),
                context=context,
            )

        if (
            _contains(text, EDUCATION_KEYWORDS)
            and _contains(text, EDUCATION_QUESTION_WORDS)
            and not CODE_PATTERN.search(reference_query)
        ):
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="education",
                requiresResearch=False,
                targetKind="knowledge",
                targets=[ResearchTarget(kind="knowledge", name="股票知识")],
            )

        security_resolved = False
        explicit_sector = _contains(reference_query, ("板块", "行业", "概念"))
        if not CODE_PATTERN.search(reference_query) and not explicit_sector:
            securities, candidates, _ = await self.market.resolve_securities(reference_query)
            if candidates:
                choices = "、".join(f"{item['name']}（{item['code']}）" for item in candidates)
                return self._clarification(f"找到多个可能的股票：{choices}。请提供六位股票代码确认。")
            security_resolved = bool(securities)
            if security_resolved:
                market_context = await self.market.context(reference_query, 120)
                if market_context.status == "ok":
                    return self._security_response(text, market_context)

        sector = None
        sector_candidates: List[Dict[str, str]] = []
        if not CODE_PATTERN.search(reference_query):
            sector, sector_candidates = await self.market.resolve_sector(reference_query)
        if sector_candidates:
            names = "、".join(item["name"] for item in sector_candidates)
            return self._clarification(f"找到多个可能的板块：{names}。请补充更准确的板块名称。")
        if sector:
            context = await self.market.sector_context(sector["kind"], sector["code"], sector["name"])
            targets = [ResearchTarget(kind="sector", name=sector["name"], code=sector["code"])]
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="sector",
                requiresResearch=True,
                targetKind="sector",
                targets=targets,
                thoughts=self._thoughts("sector", targets, context),
                context=context,
            )

        market_context = await self.market.context(reference_query, 120)
        if market_context.status == "ambiguous":
            choices = "、".join(f"{item.name}（{item.code}）" for item in market_context.candidates)
            return self._clarification(f"找到多个可能的股票：{choices}。请提供六位股票代码确认。")
        if market_context.status == "ok":
            return self._security_response(text, market_context)

        if has_stock_signal:
            return self._clarification()
        return self._out_of_scope(text)
