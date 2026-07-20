import asyncio
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from .market.service import CODE_PATTERN, MarketService
from .models import (
    ResearchPrepareRequest,
    ResearchPrepareResponse,
    ResearchTarget,
    StockIntent,
)


OUT_OF_SCOPE_MESSAGE = "我是 A 股研究助手，只能回答个股、板块、指数和股票知识问题。其他问题请切换到麦麦。"
CLARIFY_MESSAGE = "请补充具体的六位股票代码、股票名称、板块或指数名称。"
ProgressCallback = Callable[[str], Awaitable[None]]

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
SECTOR_SCAN_KEYWORDS = (
    "哪些板块", "什么板块", "哪个板块", "板块排名", "板块排行", "板块筛选", "领涨板块", "走强板块",
    "哪些行业", "什么行业", "哪个行业", "行业排名", "行业排行", "行业筛选", "领涨行业", "走强行业",
)
GENERIC_SCAN_TARGETS = ("行情", "方向", "赛道", "题材", "主题")
GENERIC_SCAN_MOVES = ("上涨", "上升", "走强", "强势", "向上", "表现好", "机会")
GENERIC_SCAN_QUESTIONS = ("什么", "哪些", "哪个")
FUNDAMENTAL_KEYWORDS = ("基本面", "财报", "营收", "利润", "现金流", "roe", "负债", "成长性")
VALUATION_KEYWORDS = ("估值", "市盈率", "市净率", "pe", "pb", "贵不贵", "便宜")
TREND_KEYWORDS = (
    "趋势", "走势", "近期", "最近", "分析", "为什么", "原因", "风险", "展望", "技术面", "支撑", "压力",
)
QUOTE_KEYWORDS = ("多少钱", "当前价格", "现在价格", "股价", "涨跌幅", "现价", "当前点位", "现在点位")
REFERENCE_WORDS = ("它", "那只", "这只", "该股", "这个板块", "该板块", "这个指数", "其")
COMPARISON_WORDS = ("对比", "比较", "相比", "vs", "VS")

SECTOR_THEMES: Dict[str, Tuple[str, ...]] = {
    "科技": ("半导体", "软件开发", "IT服务Ⅱ", "通信设备", "消费电子"),
}

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


def _sector_theme(text: str) -> Optional[Tuple[str, Tuple[str, ...]]]:
    normalized = text.replace(" ", "")
    for alias, sectors in SECTOR_THEMES.items():
        if alias in normalized:
            return alias, sectors
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


def _is_sector_scan_query(text: str) -> bool:
    if _contains(text, SECTOR_SCAN_KEYWORDS):
        return True
    if CODE_PATTERN.search(text) or _index_target(text):
        return False
    if _contains(text, ("股票", "个股", "指数")):
        return False
    return (
        _contains(text, GENERIC_SCAN_QUESTIONS)
        and _contains(text, GENERIC_SCAN_TARGETS)
        and _contains(text, GENERIC_SCAN_MOVES)
    )


def _requires_research(intent: StockIntent, text: str) -> bool:
    if intent == "index":
        return _contains(text, TREND_KEYWORDS) or "怎么样" in text or "如何" in text
    return intent in {
        "security_trend", "fundamental", "valuation", "comparison", "sector", "sector_scan", "market",
    }


def _history_summary(bars: Any) -> Dict[str, Any]:
    rows = [row for row in bars if isinstance(row, dict)] if isinstance(bars, list) else []
    summary: Dict[str, Any] = {"points": len(rows)}
    if rows:
        summary["from"] = rows[0].get("time")
        summary["to"] = rows[-1].get("time")
    return {key: value for key, value in summary.items() if value not in (None, "")}


def compact_research_context(value: Dict[str, Any]) -> Dict[str, Any]:
    def compact(item: Any) -> Any:
        if isinstance(item, dict):
            output = {}
            for key, child in item.items():
                if key == "dailyBars":
                    output["history"] = _history_summary(child)
                elif key == "warnings" and isinstance(child, list):
                    output[key] = [str(warning)[:180] for warning in child[:5]]
                else:
                    output[key] = compact(child)
            return output
        if isinstance(item, list):
            return [compact(child) for child in item[:20]]
        return item

    return compact(value)


def _number(value: Any, suffix: str = "", digits: int = 2) -> Optional[str]:
    if not isinstance(value, (int, float)):
        return None
    return f"{value:,.{digits}f}{suffix}"


def _market_cap(value: Any) -> Optional[str]:
    if not isinstance(value, (int, float)):
        return None
    return f"{value / 100_000_000:,.0f} 亿元"


def _warning_note(value: Any) -> str:
    text = str(value).replace("\n", " ").strip()
    if "：" in text and "兜底" not in text:
        text = text.split("：", 1)[0]
    return text[:100]


class ResearchService:
    def __init__(self, market: MarketService):
        self.market = market

    @staticmethod
    async def _report(progress: Optional[ProgressCallback], text: str) -> None:
        if progress:
            await progress(text)

    @classmethod
    async def _report_records(
        cls,
        progress: Optional[ProgressCallback],
        records: List[str],
    ) -> None:
        for record in records:
            await cls._report(progress, record)

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
    def _analysis_records(intent: StockIntent, context: Dict[str, Any]) -> List[str]:
        records: List[str] = []
        warnings: List[str] = list(context.get("warnings") or [])
        securities = ((context.get("market") or {}).get("securities") or [])

        if intent in {"security_trend", "fundamental", "valuation", "comparison"}:
            for security in securities:
                name = security.get("name") or security.get("code") or "标的"
                technical = security.get("technical") or {}
                financial = security.get("financial") or {}
                history = security.get("history") or {}
                warnings.extend(security.get("warnings") or [])
                if intent == "security_trend":
                    price = _number(security.get("price"), " 元")
                    change = _number(security.get("changePercent"), "%")
                    snapshot = "，".join([
                        value for value in (
                            f"现价 {price}" if price else None,
                            f"涨跌 {change}" if change else None,
                        ) if value
                    ]) or "行情快照不可用"
                    date = str(security.get("dataTime") or "")[:10]
                    records.append(
                        f"{name}{f'（{date}）' if date else ''}：{snapshot}；"
                        f"历史样本 {history.get('points', 0)} 条"
                    )
                    metrics = [
                        label for label in (
                            f"近20日 {_number(technical.get('return20d'), '%')}" if _number(technical.get("return20d"), "%") else None,
                            f"MA20 {_number(technical.get('ma20'))}" if _number(technical.get("ma20")) else None,
                            f"年化波动 {_number(technical.get('volatility20d'), '%')}" if _number(technical.get("volatility20d"), "%") else None,
                            f"60日最大回撤 {_number(technical.get('maxDrawdown60d'), '%')}" if _number(technical.get("maxDrawdown60d"), "%") else None,
                        ) if label
                    ]
                    records.append(f"{name}：{'，'.join(metrics)}" if metrics else f"{name}缺少足够历史数据，未生成趋势指标")
                elif intent == "fundamental":
                    report = financial.get("reportDate") or "最近一期"
                    metrics = [
                        label for label in (
                            f"营收同比 {_number(financial.get('revenueYoY'), '%')}" if _number(financial.get("revenueYoY"), "%") else None,
                            f"归母净利润同比 {_number(financial.get('netProfitYoY'), '%')}" if _number(financial.get("netProfitYoY"), "%") else None,
                            f"ROE {_number(financial.get('roe'), '%')}" if _number(financial.get("roe"), "%") else None,
                            f"资产负债率 {_number(financial.get('debtRatio'), '%')}" if _number(financial.get("debtRatio"), "%") else None,
                            f"每股经营现金流 {_number(financial.get('operatingCashFlowPerShare'))}" if _number(financial.get("operatingCashFlowPerShare")) else None,
                        ) if label
                    ]
                    records.append(f"{name} {report}：{'，'.join(metrics)}" if metrics else f"{name}未取得可用财务指标")
                elif intent == "valuation":
                    metrics = [
                        label for label in (
                            f"PE {_number(security.get('peRatio'))}" if _number(security.get("peRatio")) else None,
                            f"PB {_number(security.get('pbRatio'))}" if _number(security.get("pbRatio")) else None,
                            f"总市值 {_market_cap(security.get('marketCap'))}" if _market_cap(security.get("marketCap")) else None,
                            f"利润同比 {_number(financial.get('netProfitYoY'), '%')}" if _number(financial.get("netProfitYoY"), "%") else None,
                            f"近20日 {_number(technical.get('return20d'), '%')}" if _number(technical.get("return20d"), "%") else None,
                        ) if label
                    ]
                    records.append(f"{name}当前估值口径：{'，'.join(metrics)}" if metrics else f"{name}缺少可用估值数据")
                else:
                    metrics = [
                        label for label in (
                            f"现价 {_number(security.get('price'))}" if _number(security.get("price")) else None,
                            f"近20日 {_number(technical.get('return20d'), '%')}" if _number(technical.get("return20d"), "%") else None,
                            f"PE {_number(security.get('peRatio'))}" if _number(security.get("peRatio")) else None,
                            f"ROE {_number(financial.get('roe'), '%')}" if _number(financial.get("roe"), "%") else None,
                        ) if label
                    ]
                    records.append(f"{name}：{'，'.join(metrics)}" if metrics else f"{name}缺少可比较指标")
        elif intent == "sector_scan":
            criteria = context.get("criteria") or {}
            sectors = context.get("sectors") or []
            records.append(
                f"扫描 {criteria.get('universeCount', 0)} 个行业，"
                f"对 {criteria.get('scannedCount', 0)} 个候选完成了 {criteria.get('windowDays', 60)} 日趋势计算"
            )
            for sector in sectors[:5]:
                technical = sector.get("technical") or {}
                snapshot = sector.get("snapshot") or {}
                level = {"strict": "符合严格条件", "near": "接近条件", "watch": "观察项"}.get(
                    sector.get("matchLevel"),
                    "观察项",
                )
                records.append(
                    f"#{sector.get('rank', '-')} {sector.get('name', '板块')}（{level}）："
                    f"近20日 {_number(technical.get('return20d'), '%') or '数据不足'}，"
                    f"近60日 {_number(technical.get('return60d'), '%') or '数据不足'}，"
                    f"最大回撤 {_number(technical.get('maxDrawdown60d'), '%') or '数据不足'}，"
                    f"当日 {snapshot.get('advancers', 0)} 家上涨/{snapshot.get('decliners', 0)} 家下跌"
                )
            if not sectors:
                records.append("本次没有取得可用于排名的行业历史数据")
        elif intent == "sector":
            if context.get("kind") == "sector_group":
                for sector_context in context.get("sectors") or []:
                    records.extend(ResearchService._analysis_records("sector", sector_context))
            else:
                name = context.get("name") or "板块"
                snapshot = context.get("snapshot") or {}
                breadth = context.get("breadth") or {}
                technical = context.get("technical") or {}
                records.append(
                    f"{name}板块：涨跌 {_number(snapshot.get('changePercent'), '%') or '暂无'}，"
                    f"{breadth.get('advancers', 0)} 家上涨、{breadth.get('decliners', 0)} 家下跌"
                )
                leaders = context.get("leaders") or []
                leader = leaders[0] if leaders else {}
                leader_change = _number(leader.get("changePercent"), "%")
                records.append(
                    f"近20日 {_number(technical.get('return20d'), '%') or '数据不足'}；"
                    f"领涨股 {leader.get('name') or '暂无'}"
                    f"{'（' + leader_change + '）' if leader_change else ''}"
                )
        elif intent == "index":
            name = context.get("name") or "指数"
            snapshot = context.get("snapshot") or {}
            technical = context.get("technical") or {}
            records.append(
                f"{name}：点位 {_number(snapshot.get('price')) or '暂无'}，涨跌 {_number(snapshot.get('changePercent'), '%') or '暂无'}"
            )
            records.append(
                f"近20日 {_number(technical.get('return20d'), '%') or '数据不足'}，"
                f"20日波动 {_number(technical.get('volatility20d'), '%') or '数据不足'}，"
                f"60日最大回撤 {_number(technical.get('maxDrawdown60d'), '%') or '数据不足'}"
            )
        elif intent == "market":
            records.append(
                f"全市场：{context.get('advancers', 0)} 家上涨、{context.get('decliners', 0)} 家下跌，"
                f"中位涨跌 {_number(context.get('medianChangePercent'), '%') or '暂无'}"
            )
            records.append(
                f"两市成交额 {_market_cap(context.get('totalAmount')) or '暂无'}；"
                f"领涨 {('、'.join(item.get('name', '') for item in (context.get('leaders') or [])[:3]) or '暂无')}"
            )

        for warning in list(dict.fromkeys(_warning_note(item) for item in warnings if item))[:3]:
            records.append(f"数据说明：{warning}")
        return [record for record in records if record]

    async def _security_response(
        self,
        text: str,
        market_context,
        progress: Optional[ProgressCallback] = None,
    ) -> ResearchPrepareResponse:
        targets = [
            ResearchTarget(kind="security", name=item.name, code=item.code)
            for item in market_context.securities
        ]
        intent = _intent_for_security(text, len(targets))
        requires = _requires_research(intent, text)
        context = compact_research_context({
            "kind": "security",
            "market": market_context.model_dump(exclude_none=True),
        })
        warnings = [warning for item in market_context.securities for warning in item.warnings]
        if warnings:
            context["warnings"] = warnings
        thoughts = self._analysis_records(intent, context) if requires else []
        await self._report_records(progress, thoughts)
        return ResearchPrepareResponse(
            scope="in_scope",
            intent=intent,
            requiresResearch=requires,
            targetKind="security",
            targets=targets,
            thoughts=thoughts,
            context=context,
        )

    async def prepare(
        self,
        request: ResearchPrepareRequest,
        progress: Optional[ProgressCallback] = None,
    ) -> ResearchPrepareResponse:
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
            if requires:
                await self._report(progress, f"正在获取{index['name']}的行情和历史数据")
            context = compact_research_context(
                await self.market.index_context(index["code"], index["name"], index["category"]),
            )
            targets = [ResearchTarget(kind="index", name=index["name"], code=index["code"])]
            thoughts = self._analysis_records(intent, context) if requires else []
            await self._report_records(progress, thoughts)
            return ResearchPrepareResponse(
                scope="in_scope",
                intent=intent,
                requiresResearch=requires,
                targetKind="index",
                targets=targets,
                thoughts=thoughts,
                context=context,
            )

        if _contains(reference_query, MARKET_KEYWORDS):
            await self._report(progress, "正在获取全市场涨跌、成交额和市场宽度数据")
            context = compact_research_context(await self.market.market_overview())
            targets = [ResearchTarget(kind="market", name="A 股市场")]
            thoughts = self._analysis_records("market", context)
            await self._report_records(progress, thoughts)
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="market",
                requiresResearch=True,
                targetKind="market",
                targets=targets,
                thoughts=thoughts,
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

        if _is_sector_scan_query(reference_query):
            await self._report(progress, "正在读取全市场行业快照")
            context = compact_research_context(
                await self.market.scan_sectors(limit=5, window_days=60, progress=progress),
            )
            targets = [
                ResearchTarget(kind="sector", name=item.get("name") or "行业板块", code=item.get("code"))
                for item in (context.get("sectors") or [])[:5]
            ]
            thoughts = self._analysis_records("sector_scan", context)
            await self._report_records(progress, thoughts[1:])
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="sector_scan",
                requiresResearch=True,
                targetKind="sector",
                targets=targets,
                thoughts=thoughts,
                context=context,
            )

        theme = _sector_theme(reference_query)
        if theme:
            theme_name, sector_names = theme
            await self._report(
                progress,
                f"正在把{theme_name}主题拆分为可查询的标准行业",
            )
            sectors = await self.market.resolve_sector_names(list(sector_names))
            if not sectors:
                return self._clarification(f"暂时无法取得{theme_name}主题的行业分类数据，请稍后重试。")
            await self._report(
                progress,
                f"已识别 {'、'.join(item['name'] for item in sectors)}，开始获取行情和历史趋势",
            )
            tasks = [asyncio.create_task(self.market.sector_context(
                item["kind"],
                item["code"],
                item["name"],
            )) for item in sectors]
            sector_contexts = []
            for task in asyncio.as_completed(tasks):
                sector_context = compact_research_context(await task)
                sector_contexts.append(sector_context)
                await self._report_records(
                    progress,
                    self._analysis_records("sector", sector_context),
                )
            sector_contexts.sort(
                key=lambda item: (item.get("technical") or {}).get("return20d")
                if (item.get("technical") or {}).get("return20d") is not None else float("-inf"),
                reverse=True,
            )
            context = {
                "kind": "sector_group",
                "status": "ok" if sector_contexts else "unavailable",
                "name": theme_name,
                "sectors": sector_contexts,
            }
            thoughts = self._analysis_records("sector", context)
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="sector",
                requiresResearch=True,
                targetKind="sector",
                targets=[
                    ResearchTarget(kind="sector", name=item["name"], code=item["code"])
                    for item in sectors
                ],
                thoughts=thoughts,
                context=context,
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
                intent = _intent_for_security(text, len(securities))
                if _requires_research(intent, text):
                    names = "、".join(item["name"] for item in securities)
                    await self._report(progress, f"正在获取{names}的行情、财务和历史数据")
                market_context = await self.market.context(reference_query, 120)
                if market_context.status == "ok":
                    return await self._security_response(text, market_context, progress)

        sector = None
        sector_candidates: List[Dict[str, str]] = []
        if not CODE_PATTERN.search(reference_query):
            sector, sector_candidates = await self.market.resolve_sector(reference_query)
        if sector_candidates:
            names = "、".join(item["name"] for item in sector_candidates)
            return self._clarification(f"找到多个可能的板块：{names}。请补充更准确的板块名称。")
        if sector:
            await self._report(progress, f"正在获取{sector['name']}板块的行情、成分股和历史数据")
            context = compact_research_context(
                await self.market.sector_context(sector["kind"], sector["code"], sector["name"]),
            )
            targets = [ResearchTarget(kind="sector", name=sector["name"], code=sector["code"])]
            thoughts = self._analysis_records("sector", context)
            await self._report_records(progress, thoughts)
            return ResearchPrepareResponse(
                scope="in_scope",
                intent="sector",
                requiresResearch=True,
                targetKind="sector",
                targets=targets,
                thoughts=thoughts,
                context=context,
            )

        target_count = max(1, len(CODE_PATTERN.findall(reference_query)))
        likely_intent = _intent_for_security(text, target_count)
        if CODE_PATTERN.search(reference_query) and _requires_research(likely_intent, text):
            await self._report(progress, "正在解析标的并获取行情、财务和历史数据")
        market_context = await self.market.context(reference_query, 120)
        if market_context.status == "ambiguous":
            choices = "、".join(f"{item.name}（{item.code}）" for item in market_context.candidates)
            return self._clarification(f"找到多个可能的股票：{choices}。请提供六位股票代码确认。")
        if market_context.status == "ok":
            return await self._security_response(text, market_context, progress)

        if has_stock_signal:
            return self._clarification()
        return self._out_of_scope(text)
