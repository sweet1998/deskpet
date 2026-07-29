import asyncio
from datetime import datetime, time as clock_time, timedelta
import math
import re
from statistics import stdev
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from ..cache import TTLCache
from ..models import MarketContextResponse, SecurityContext
from .providers.base import MarketProvider
from .providers.eastmoney import map_symbol

if TYPE_CHECKING:
    from ..quant.service import QuantService


CODE_PATTERN = re.compile(r"(?<!\d)(\d{6})(?!\d)")
ProgressCallback = Callable[[str], Awaitable[None]]
WEEKDAY_NAMES = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
STOP_WORDS = (
    "请", "帮我", "分析一下", "分析", "看看", "研究", "怎么样", "如何", "走势", "股票", "A股",
    "最近", "近期", "当前", "现在", "今天", "行情", "趋势", "价格", "股价", "基本面", "财报", "估值",
    "风险", "原因", "为什么", "对比", "比较", "多少钱", "表现", "营收", "利润", "现金流", "负债",
    "成长性", "市盈率", "市净率", "贵不贵", "便宜", "支撑", "压力", "展望", "的", "好吗", "好不好",
    "还好吗", "咋回事", "怎么了", "整体如何", "热不热", "弱不弱", "有啥变化", "什么情况",
    "最新", "新闻", "消息面", "公告", "舆情", "事件", "利好", "利空", "能买吗", "要不要买", "该不该买",
    "值得买吗", "买入", "卖出", "要不要卖", "该不该卖", "继续持有", "加仓", "减仓", "止盈", "止损",
)
KNOWN_SECTORS: Dict[str, List[Dict[str, str]]] = {
    "industry": [
        {"kind": "industry_ths", "code": "881273", "name": "白酒"},
    ],
    "concept": [],
}
KNOWN_SECTOR_BASKETS: Dict[str, List[Tuple[str, str]]] = {
    "白酒": [
        ("SH.600519", "贵州茅台"),
        ("SZ.000858", "五粮液"),
        ("SZ.000568", "泸州老窖"),
        ("SH.600809", "山西汾酒"),
        ("SZ.000596", "古井贡酒"),
    ],
}


def market_state(now: datetime) -> str:
    if now.weekday() >= 5:
        return "closed"
    current = now.time()
    if clock_time(9, 30) <= current <= clock_time(11, 30):
        return "trading"
    if clock_time(13, 0) <= current <= clock_time(15, 0):
        return "trading"
    return "closed"


def search_terms(query: str) -> List[str]:
    normalized = query
    for word in STOP_WORDS:
        normalized = normalized.replace(word, " ")
    return [term for term in re.findall(r"[\u4e00-\u9fffA-Za-z]{2,20}", normalized)[:5]]


def _rounded(value: float) -> float:
    return round(value, 4)


def technical_summary(bars: List[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    closes = [float(row["close"]) for row in bars if row.get("close") not in (None, 0)]

    def period_return(days: int) -> Optional[float]:
        if len(closes) < days + 1:
            return None
        return _rounded((closes[-1] / closes[-days - 1] - 1) * 100)

    def moving_average(days: int) -> Optional[float]:
        if len(closes) < days:
            return None
        return _rounded(sum(closes[-days:]) / days)

    volatility = None
    if len(closes) >= 21:
        returns = [closes[index] / closes[index - 1] - 1 for index in range(len(closes) - 19, len(closes))]
        volatility = _rounded(stdev(returns) * math.sqrt(252) * 100)

    max_drawdown = None
    if len(closes) >= 60:
        peak = closes[-60]
        drawdowns = []
        for close in closes[-60:]:
            peak = max(peak, close)
            drawdowns.append(close / peak - 1)
        max_drawdown = _rounded(min(drawdowns) * 100)

    return {
        "return5d": period_return(5),
        "return20d": period_return(20),
        "return60d": period_return(60),
        "ma5": moving_average(5),
        "ma20": moving_average(20),
        "ma60": moving_average(60),
        "volatility20d": volatility,
        "maxDrawdown60d": max_drawdown,
    }


class MarketService:
    _PROFESSIONAL_CAPABILITY_BY_METHOD = {
        "daily_bars": "adjusted_daily_kline_from_preclose",
        "company_profile": "security_master",
        "financial_snapshot": "financial_history",
        "financial_history": "financial_history",
        "trade_calendar": "trade_calendar",
    }

    def __init__(
        self,
        provider: MarketProvider,
        cache: TTLCache,
        fallback_provider: Optional[MarketProvider] = None,
        universe_fallback_provider: Optional[MarketProvider] = None,
        professional_provider: Optional[MarketProvider] = None,
        announcement_provider: Optional[MarketProvider] = None,
        quant_service: Optional["QuantService"] = None,
    ):
        self.provider = provider
        self.fallback_provider = fallback_provider
        self.universe_fallback_provider = universe_fallback_provider
        self.professional_provider = professional_provider
        self.announcement_provider = announcement_provider
        self.quant_service = quant_service
        self.cache = cache
        self._sector_scan_lock = asyncio.Lock()
        self._sector_scan_progress_listeners: List[ProgressCallback] = []
        self._sector_catalog_memory: Dict[str, List[Dict[str, str]]] = {}
        self._sector_catalog_locks = {
            "industry": asyncio.Lock(),
            "concept": asyncio.Lock(),
        }

    @staticmethod
    def _has_data(value: Any) -> bool:
        return value is not None and value != {} and value != []

    async def _fetch(
        self,
        method: str,
        *args: Any,
    ) -> Tuple[Any, str, Optional[str]]:
        errors = []
        providers: List[MarketProvider] = []
        preferred = []
        required_capability = self._PROFESSIONAL_CAPABILITY_BY_METHOD.get(method)
        professional_capabilities = getattr(self.professional_provider, "capabilities", ())
        if required_capability and required_capability in professional_capabilities:
            preferred.append(self.professional_provider)
        elif method == "company_announcements":
            preferred.append(self.announcement_provider)
        preferred.extend((self.provider, self.fallback_provider))
        for provider in preferred:
            if provider and all(item.name != provider.name for item in providers):
                providers.append(provider)
        for index, provider in enumerate(providers):
            try:
                value = await getattr(provider, method)(*args)
                valid_empty_announcement_result = (
                    method == "company_announcements"
                    and provider is self.announcement_provider
                    and isinstance(value, list)
                )
                if not self._has_data(value) and not valid_empty_announcement_result:
                    raise RuntimeError("没有返回数据")
                warning = None
                if index:
                    label = "优先数据源" if preferred[0] is not self.provider else "主数据源"
                    warning = f"{method} {label}失败，已使用 {provider.name} 兜底"
                return value, provider.name, warning
            except Exception as error:
                errors.append(f"{provider.name}: {error}")
        raise RuntimeError("；".join(errors))

    async def _cached_fetch(
        self,
        key: str,
        ttl: int,
        loader: Callable[[], Awaitable[Tuple[Any, str, Optional[str]]]],
    ) -> Tuple[Any, str, Optional[str]]:
        cached = await self.cache.get(key)
        if isinstance(cached, dict) and "value" in cached and "source" in cached:
            return cached["value"], cached["source"], cached.get("warning")
        try:
            value, source, warning = await loader()
        except Exception as error:
            stale_max_age = min(max(ttl * 60, 60 * 60), 7 * 24 * 60 * 60)
            stale = await self.cache.get_stale(key, stale_max_age)
            if isinstance(stale, dict) and "value" in stale and "source" in stale:
                cached_at = stale.get("cachedAt")
                stale_warning = "实时数据源暂时不可用，已使用本机最近一次成功缓存；该数据不得视为实时行情"
                if cached_at:
                    stale_warning += f"（缓存时间 {cached_at}）"
                previous = stale.get("warning")
                return stale["value"], stale["source"], "；".join(
                    item for item in (previous, stale_warning) if item
                )
            raise error
        await self.cache.set(key, {
            "value": value,
            "source": source,
            "warning": warning,
            "cachedAt": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
        }, ttl)
        return value, source, warning

    async def _fetch_stock_universe(self) -> Tuple[Any, str, Optional[str]]:
        providers = [self.provider]
        for provider in (self.universe_fallback_provider, self.fallback_provider):
            if provider and all(item.name != provider.name for item in providers):
                providers.append(provider)
        errors = []
        for index, provider in enumerate(providers):
            try:
                value = await provider.stock_universe_snapshot()
                if not self._has_data(value):
                    raise RuntimeError("没有返回全市场股票池")
                warning = None
                if index:
                    warning = (
                        f"全市场股票池主源暂不可用，已自动切换至 {provider.name}，"
                        "本次筛选继续完成"
                    )
                return value, provider.name, warning
            except Exception as error:
                errors.append(f"{provider.name}: {error}")
        raise RuntimeError("；".join(errors))

    async def quant_instrument_fallback(self) -> List[Dict[str, Any]]:
        universe, source, _ = await self._cached_fetch(
            "market:v3:stock-universe-snapshot",
            300,
            self._fetch_stock_universe,
        )
        ingested_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        return [{
            "instrumentId": str(row["code"]),
            "symbol": str(row["code"]).split(".", 1)[-1],
            "name": str(row.get("name") or row["code"]),
            "industry": row.get("industry"),
            "market": row.get("market"),
            "listDate": None,
            "listStatus": "L",
            "validFrom": None,
            "validTo": None,
            "source": source,
            "ingestedAt": ingested_at,
        } for row in universe if row.get("code")]

    async def _optional_fetch(
        self,
        key: str,
        ttl: int,
        method: str,
        label: str,
        *args: Any,
    ) -> Tuple[Any, Optional[str], Optional[str]]:
        try:
            return await self._cached_fetch(
                key,
                ttl,
                lambda: self._fetch(method, *args),
            )
        except Exception as error:
            empty_value: Any = [] if method in {
                "daily_bars", "financial_history", "security_news", "company_announcements",
            } else {}
            return empty_value, None, f"{label}获取失败：{str(error)[:240]}"

    async def _search(self, term: str) -> Tuple[List[Dict[str, str]], str, Optional[str]]:
        primary_error = None
        try:
            rows = await self.provider.search(term)
            if rows:
                return rows, self.provider.name, None
        except Exception as error:
            primary_error = str(error)
        if self.fallback_provider and self.fallback_provider.name != self.provider.name:
            try:
                rows = await self.fallback_provider.search(term)
                if rows:
                    return rows, self.fallback_provider.name, (
                        f"名称解析已使用 {self.fallback_provider.name} 兜底"
                    )
            except Exception:
                pass
        return [], self.provider.name, (
            f"名称解析失败：{primary_error}" if primary_error else None
        )

    async def _resolve(
        self,
        query: str,
    ) -> Tuple[List[Dict[str, str]], List[Dict[str, str]], List[str]]:
        codes = []
        for symbol in CODE_PATTERN.findall(query):
            code = map_symbol(symbol)
            if code and code not in codes:
                codes.append(code)
        if codes:
            return [
                {"code": code, "name": code.split(".")[1], "market": code[:2]}
                for code in codes[:3]
            ], [], []

        exact_matches: Dict[str, Dict[str, str]] = {}
        fuzzy_matches: Dict[str, Dict[str, str]] = {}
        warnings: List[str] = []
        for term in search_terms(query):
            cache_key = f"market:v2:resolve:{term}"
            rows, _, warning = await self._cached_fetch(
                cache_key,
                86400,
                lambda term=term: self._search(term),
            )
            if warning and warning not in warnings:
                warnings.append(warning)
            exact = [row for row in rows if row["name"] == term]
            if exact:
                for row in exact:
                    exact_matches[row["code"]] = row
                continue
            for row in rows[:5]:
                fuzzy_matches[row["code"]] = row
        if exact_matches:
            return list(exact_matches.values())[:3], [], warnings
        values = list(fuzzy_matches.values())
        if len(values) == 1:
            return values, [], warnings
        if len(values) > 1:
            return [], values[:10], warnings
        return [], [], warnings

    async def _security_context(
        self,
        item: Dict[str, str],
        daily_count: int,
        now: datetime,
        state: str,
        inherited_warnings: List[str],
        include_events: bool = False,
    ) -> SecurityContext:
        code = item["code"]
        snapshot_task = self._cached_fetch(
            f"market:v2:snapshot:{code}",
            15,
            lambda: self._fetch("snapshot", code),
        )
        bars_task = self._optional_fetch(
            f"market:v3:kline:{code}:{daily_count}",
            900,
            "daily_bars",
            "日 K",
            code,
            daily_count,
        )
        profile_task = self._optional_fetch(
            f"market:v3:profile:{code}",
            86400,
            "company_profile",
            "公司资料",
            code,
        )
        financial_history_task = self._optional_fetch(
            f"market:v3:financial-history:{code}:12",
            21600,
            "financial_history",
            "多期财务指标",
            code,
            12,
        )
        event_tasks = []
        if include_events:
            event_tasks = [
                self._optional_fetch(
                    f"market:v1:news:{code}:10",
                    300,
                    "security_news",
                    "个股新闻",
                    code,
                    10,
                ),
                self._optional_fetch(
                    f"market:v1:announcements:{code}:7:10",
                    900,
                    "company_announcements",
                    "公司公告",
                    code,
                    7,
                    10,
                ),
            ]
        results = await asyncio.gather(
            snapshot_task,
            bars_task,
            profile_task,
            financial_history_task,
            *event_tasks,
        )
        snapshot_result, bars_result, profile_result, financial_history_result = results[:4]
        snapshot, snapshot_source, snapshot_warning = snapshot_result
        bars, bars_source, bars_warning = bars_result
        profile, profile_source, profile_warning = profile_result
        financial_history, financial_history_source, financial_history_warning = financial_history_result
        if financial_history:
            financial = financial_history[0]
            financial_source = financial_history_source
            financial_warning = None
        else:
            financial, financial_source, financial_warning = await self._optional_fetch(
                f"market:v3:financial:{code}",
                21600,
                "financial_snapshot",
                "财务指标",
                code,
            )
        news, news_source, news_warning = results[4] if include_events else ([], None, None)
        announcements, announcements_source, announcements_warning = (
            results[5] if include_events else ([], None, None)
        )
        snapshot = dict(snapshot)
        profile = dict(profile)
        if not profile.get("floatMarketCap") and snapshot.get("floatMarketCap"):
            profile["floatMarketCap"] = snapshot["floatMarketCap"]
        warnings = list(dict.fromkeys([
            *inherited_warnings,
            *(
                warning for warning in (
                    snapshot_warning,
                    bars_warning,
                    profile_warning,
                    financial_warning,
                    financial_history_warning,
                    news_warning,
                    announcements_warning,
                ) if warning
            ),
        ]))
        data_sources = {
            key: source
            for key, source in {
                "snapshot": snapshot_source,
                "dailyKline": bars_source,
                "profile": profile_source,
                "financial": financial_source,
                "financialHistory": financial_history_source,
                "technical": bars_source,
                "news": news_source,
                "announcements": announcements_source,
            }.items()
            if source
        }
        snapshot.update({
            "dailyBars": bars,
            "profile": profile,
            "financial": financial,
            "financialHistory": financial_history,
            "technical": technical_summary(bars),
            "news": news,
            "announcements": announcements,
            "dataSources": data_sources,
            "warnings": warnings,
            "marketStatus": state,
            "stale": bool(snapshot_warning and "本机最近一次成功缓存" in snapshot_warning)
            or self._is_stale(snapshot.get("dataTime", ""), now, state),
        })
        return SecurityContext.model_validate(snapshot)

    async def resolve_securities(
        self,
        query: str,
    ) -> Tuple[List[Dict[str, str]], List[Dict[str, str]], List[str]]:
        return await self._resolve(query)

    async def context(
        self,
        query: str,
        daily_count: int = 120,
        include_events: bool = False,
    ) -> MarketContextResponse:
        try:
            securities, candidates, resolve_warnings = await self._resolve(query)
            if candidates:
                return MarketContextResponse(
                    status="ambiguous",
                    source=self.provider.name,
                    candidates=candidates,
                )
            if not securities:
                return MarketContextResponse(status="no-symbol", source=self.provider.name)

            now = datetime.now(ZoneInfo("Asia/Shanghai"))
            state = market_state(now)
            output = await asyncio.gather(*(
                self._security_context(item, daily_count, now, state, resolve_warnings, include_events)
                for item in securities[:3]
            ))
            sources = list(dict.fromkeys(
                source
                for security in output
                for source in security.dataSources.values()
            ))
            return MarketContextResponse(
                status="ok",
                source=sources[0] if len(sources) == 1 else "mixed",
                asOf=now.isoformat(),
                marketStatus=state,
                securities=output,
            )
        except Exception as error:
            return MarketContextResponse(
                status="unavailable",
                source=self.provider.name,
                error=str(error)[:500],
            )

    async def security_events(self, query: str, days: int = 7, limit: int = 10) -> Dict[str, Any]:
        safe_days = max(1, min(30, days))
        safe_limit = max(1, min(20, limit))
        securities, candidates, resolve_warnings = await self._resolve(query)
        if candidates:
            return {
                "kind": "security_events",
                "status": "ambiguous",
                "candidates": candidates,
                "events": [],
                "warnings": resolve_warnings,
            }
        if not securities:
            return {
                "kind": "security_events",
                "status": "no-symbol",
                "events": [],
                "warnings": resolve_warnings,
            }
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        output = []
        warnings = list(resolve_warnings)
        sources: Dict[str, str] = {}
        for item in securities[:3]:
            code = item["code"]
            news_result, announcements_result = await asyncio.gather(
                self._optional_fetch(
                    f"market:v1:news:{code}:{safe_limit}", 300, "security_news", "个股新闻", code, safe_limit,
                ),
                self._optional_fetch(
                    f"market:v1:announcements:{code}:{safe_days}:{safe_limit}",
                    900, "company_announcements", "公司公告", code, safe_days, safe_limit,
                ),
            )
            news, news_source, news_warning = news_result
            announcements, announcement_source, announcement_warning = announcements_result
            output.extend(news)
            output.extend(announcements)
            if news_source:
                sources["news"] = news_source
            if announcement_source:
                sources["announcements"] = announcement_source
            warnings.extend(item for item in (news_warning, announcement_warning) if item)
        deduped = {item["sourceId"]: item for item in output if item.get("sourceId")}
        events = sorted(deduped.values(), key=lambda item: item.get("publishedAt") or "", reverse=True)
        return {
            "kind": "security_events",
            "status": "ok",
            "asOf": now.isoformat(),
            "securities": securities[:3],
            "events": events[:safe_limit],
            "dataSources": sources,
            "warnings": list(dict.fromkeys(warnings)),
            "dataGaps": ["没有取得可用的新闻或公告"] if not events else [],
        }

    @staticmethod
    def _screen_metric(value: Any, low: float, high: float, inverse: bool = False) -> Optional[float]:
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            return None
        score = max(0.0, min(100.0, (float(value) - low) / (high - low) * 100))
        return 100 - score if inverse else score

    async def _fetch_screen_snapshot(self, code: str) -> Tuple[Any, str, Optional[str]]:
        providers = []
        for provider in (self.fallback_provider, self.provider):
            if provider and all(item.name != provider.name for item in providers):
                providers.append(provider)
        errors = []
        for index, provider in enumerate(providers):
            try:
                value = await provider.snapshot(code)
                if not self._has_data(value):
                    raise RuntimeError("没有返回估值快照")
                warning = f"{code} 估值补齐已使用 {provider.name}" if index else None
                return value, provider.name, warning
            except Exception as error:
                errors.append(f"{provider.name}: {error}")
        raise RuntimeError("；".join(errors))

    async def _deep_enrich_quant_candidates(
        self,
        rows: List[Dict[str, Any]],
        style: str,
        progress: Optional[ProgressCallback],
    ) -> List[Dict[str, Any]]:
        weights = {
            "balanced": {"quality": .25, "growth": .2, "value": .2, "momentum": .2, "risk": .15},
            "quality": {"quality": .5, "growth": .15, "value": .15, "momentum": .05, "risk": .15},
            "growth": {"quality": .15, "growth": .5, "value": .1, "momentum": .15, "risk": .1},
            "value": {"quality": .2, "growth": .1, "value": .5, "momentum": .05, "risk": .15},
            "momentum": {"quality": .1, "growth": .1, "value": .05, "momentum": .55, "risk": .2},
        }[style]
        semaphore = asyncio.Semaphore(10)

        def average(values: List[Optional[float]]) -> Optional[float]:
            available = [value for value in values if value is not None]
            return sum(available) / len(available) if available else None

        async def bounded_fetch(
            timeout: float,
            key: str,
            ttl: int,
            method: str,
            label: str,
            *args: Any,
        ) -> Tuple[Any, Optional[str], Optional[str]]:
            try:
                return await asyncio.wait_for(
                    self._optional_fetch(key, ttl, method, label, *args),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                empty: Any = [] if method in {"security_news", "company_announcements"} else {}
                return empty, None, f"{label}超过 {timeout:.0f} 秒未返回，已跳过以保证响应速度"

        async def enrich(row: Dict[str, Any]) -> Dict[str, Any]:
            code = str(row["code"])
            async with semaphore:
                financial_result, valuation_result, news_result, announcements_result = await asyncio.gather(
                    bounded_fetch(
                        10,
                        f"market:v3:financial:{code}", 21600, "financial_snapshot", "财务指标", code,
                    ),
                    bounded_fetch(
                        10,
                        f"market:v2:screen-snapshot:{code}", 300, "snapshot", "估值快照", code,
                    ),
                    bounded_fetch(
                        6,
                        f"market:v1:news:{code}:3", 300, "security_news", "个股新闻", code, 3,
                    ),
                    bounded_fetch(
                        6,
                        f"market:v1:announcements:{code}:7:3",
                        900,
                        "company_announcements",
                        "公司公告",
                        code,
                        7,
                        3,
                    ),
                )
            financial, financial_source, financial_warning = financial_result
            snapshot, snapshot_source, snapshot_warning = valuation_result
            news, news_source, news_warning = news_result
            announcements, announcement_source, announcement_warning = announcements_result
            quality = average([
                self._screen_metric(financial.get("roe"), 5, 25),
                self._screen_metric(financial.get("debtRatio"), 20, 80, True),
                self._screen_metric(financial.get("operatingCashFlowPerShare"), 0, 5),
            ])
            growth = average([
                self._screen_metric(financial.get("revenueYoY"), -10, 40),
                self._screen_metric(financial.get("netProfitYoY"), -10, 40),
            ])
            value = average([
                self._screen_metric(snapshot.get("peRatio"), 8, 60, True),
                self._screen_metric(snapshot.get("pbRatio"), 1, 10, True),
            ])
            components = {
                "quality": quality if quality is not None else row.get("quality"),
                "growth": growth if growth is not None else row.get("growth"),
                "value": value if value is not None else row.get("value"),
                "momentum": row.get("momentum") if isinstance(row.get("momentum"), (int, float)) else None,
                "risk": row.get("risk") if isinstance(row.get("risk"), (int, float)) else None,
            }
            available_weight = sum(weight for key, weight in weights.items() if components[key] is not None)
            coverage = available_weight / sum(weights.values())
            raw_score = (
                sum(float(components[key]) * weight for key, weight in weights.items() if components[key] is not None)
                / available_weight
                if available_weight else 0
            )
            selection_score = raw_score * (.65 + .35 * coverage)
            gaps = [key for key, value in components.items() if value is None]
            return {
                **row,
                "factorRank": row.get("rank"),
                "factorScore": row.get("score"),
                "factorCoverage": row.get("coverage"),
                "factorScoreBreakdown": {
                    key: row.get(key) for key in ("quality", "growth", "value", "momentum", "risk")
                },
                "price": snapshot.get("price") if snapshot.get("price") is not None else row.get("price"),
                "changePercent": (
                    snapshot.get("changePercent")
                    if snapshot.get("changePercent") is not None else row.get("changePercent")
                ),
                "peRatio": snapshot.get("peRatio"),
                "pbRatio": snapshot.get("pbRatio"),
                "marketCap": snapshot.get("marketCap"),
                "financial": financial,
                "news": list(news)[:3],
                "announcements": list(announcements)[:3],
                "eventSummary": {
                    "newsCount": len(news),
                    "announcementCount": len(announcements),
                    "officialAnnouncementCount": sum(
                        item.get("verificationStatus") == "official" for item in announcements
                    ),
                },
                "score": round(selection_score, 2),
                "researchScore": round(raw_score, 2),
                "coverage": round(coverage, 4),
                "confidence": "high" if coverage >= .8 else "medium" if coverage >= .55 else "low",
                "scoreBreakdown": {
                    key: round(value, 2) if value is not None else None
                    for key, value in components.items()
                },
                "dataSources": {
                    **dict(row.get("dataSources") or {}),
                    **({"snapshot": snapshot_source} if snapshot_source else {}),
                    **({"financial": financial_source} if financial_source else {}),
                    **({"news": news_source} if news_source else {}),
                    **({"announcements": announcement_source} if announcement_source else {}),
                },
                "dataGaps": gaps,
                "warnings": [
                    item for item in (
                        financial_warning, snapshot_warning, news_warning, announcement_warning,
                    ) if item
                ],
            }

        enriched = await asyncio.gather(*(enrich(row) for row in rows))
        ranked = sorted(
            enriched,
            key=lambda row: (row["score"], row.get("factorScore") or 0),
            reverse=True,
        )
        for rank, row in enumerate(ranked, start=1):
            row["deepRank"] = rank
            row["rank"] = rank
        await self._report(progress, f"已完成 {len(ranked)} 只候选的财务、估值与因子二次评分")
        return ranked

    async def screen_stocks(
        self,
        style: str = "balanced",
        limit: int = 5,
        progress: Optional[ProgressCallback] = None,
        deep_limit: int = 20,
    ) -> Dict[str, Any]:
        safe_style = style if style in {"balanced", "quality", "growth", "value", "momentum"} else "balanced"
        safe_limit = max(1, min(10, limit))
        safe_deep_limit = max(10, min(50, deep_limit))
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        quant_warning = None
        if self.quant_service is not None:
            await self._report(progress, "正在检查本地 DuckDB 量化仓库并准备全市场因子截面")
            try:
                quant_status = await self.quant_service.status()
                factor_result = await self.quant_service.screen(safe_style, 100)
                shortlist_style = safe_style
                shortlist_warning = None
                if factor_result.get("status") != "ok" and safe_style != "balanced":
                    baseline_result = await self.quant_service.screen("balanced", 100)
                    if baseline_result.get("status") == "ok":
                        factor_result = baseline_result
                        shortlist_style = "balanced"
                        shortlist_warning = (
                            f"全市场 {safe_style} 因子覆盖不足，前100候选池暂按可用的 balanced 因子建立；"
                            "请求风格仅用于前20名二次评分"
                        )
                if factor_result.get("status") == "ok" and factor_result.get("stocks"):
                    shortlist = list(factor_result["stocks"][:100])
                    await self._report(
                        progress,
                        f"量化因子引擎已完成 {factor_result.get('universeCount', 0)} 只合格股票的全市场排名，保留前 {len(shortlist)} 名",
                    )
                    deep_candidates = await self._deep_enrich_quant_candidates(
                        shortlist[:safe_deep_limit], safe_style, progress,
                    )
                    stocks = deep_candidates[:safe_limit]
                    criteria = dict(factor_result.get("criteria") or {})
                    criteria.update({
                        "universeCount": quant_status.get("instruments", factor_result.get("universeCount", 0)),
                        "eligibleCount": factor_result.get("universeCount", 0),
                        "shortlistCount": len(shortlist),
                        "enrichedCount": len(deep_candidates),
                        "finalCount": len(stocks),
                        "scorePolicy": "缺失维度不填中性分；二次评分按实际可用权重计算，并用覆盖率直接降低最终分",
                        "shortlistData": "全市场仓库中的历史行情、财务、估值和因子字段",
                        "deepAnalysisData": "财务快照、估值快照、新闻、官方公告、动量与风险因子",
                        "requestedStyle": safe_style,
                        "shortlistStyle": shortlist_style,
                    })
                    warnings = list(factor_result.get("warnings") or [])
                    if shortlist_warning:
                        warnings.append(shortlist_warning)
                    if any(row.get("dataGaps") for row in deep_candidates):
                        warnings.append("部分深度候选仍缺少财务或估值维度，已降低覆盖率和最终分")
                    return {
                        **factor_result,
                        "kind": "stock_screen",
                        "engine": "layered_multi_factor",
                        "style": safe_style,
                        "stocks": stocks,
                        "deepCandidates": deep_candidates,
                        "shortlistCandidates": [{
                            "code": row.get("code"),
                            "name": row.get("name"),
                            "factorRank": row.get("rank"),
                            "factorScore": row.get("score"),
                            "factorCoverage": row.get("coverage"),
                            "confidence": row.get("confidence"),
                            "dataGaps": [
                                key for key in ("quality", "growth", "value", "momentum", "risk")
                                if row.get(key) is None
                            ],
                        } for row in shortlist],
                        "criteria": criteria,
                        "analysisFunnel": {
                            "universeCount": criteria["universeCount"],
                            "factorEligibleCount": criteria["eligibleCount"],
                            "shortlistCount": len(shortlist),
                            "deepAnalyzedCount": len(deep_candidates),
                            "finalCount": len(stocks),
                        },
                        "warnings": list(dict.fromkeys(warnings)),
                        "dataGaps": sorted({gap for row in deep_candidates for gap in row.get("dataGaps", [])}),
                    }
                quant_warning = str(
                    factor_result.get("error") or "本地量化仓库暂时没有可用因子截面"
                )
            except Exception as error:
                quant_warning = f"量化因子引擎执行失败：{str(error)[:180]}"
            await self._report(progress, f"{quant_warning}；本次已明确降级到实时快照筛选")
        try:
            universe, source, source_warning = await self._cached_fetch(
                "market:v3:stock-universe-snapshot",
                300,
                self._fetch_stock_universe,
            )
        except Exception as error:
            return {
                "kind": "stock_screen", "status": "unavailable", "style": safe_style,
                "asOf": now.isoformat(), "stocks": [],
                "warnings": [f"全市场个股快照获取失败：{str(error)[:240]}"],
                "dataGaps": ["无法取得筛选股票池"],
            }
        await self._report(progress, f"已从 {source} 获取 {len(universe)} 只股票，开始流动性预筛")

        prefiltered = [row for row in universe if (
            row.get("code") and row.get("name")
            and "ST" not in str(row.get("name") or "").upper()
            and isinstance(row.get("price"), (int, float)) and row["price"] > 0
            and isinstance(row.get("amount"), (int, float)) and row["amount"] >= 50_000_000
            and (not isinstance(row.get("marketCap"), (int, float)) or row["marketCap"] >= 5_000_000_000)
            and (not isinstance(row.get("peRatio"), (int, float)) or 0 < row["peRatio"] <= 100)
            and (not isinstance(row.get("pbRatio"), (int, float)) or 0 < row["pbRatio"] <= 15)
        )]
        prefiltered.sort(
            key=lambda row: (
                math.log10(max(float(row.get("amount") or 1), 1))
                + math.log10(max(float(row.get("marketCap") or 1), 1)) * .25
                - float(row.get("peRatio") or 100) / 50
            ),
            reverse=True,
        )
        valuation_pool = prefiltered[:max(40, safe_limit * 8)]
        valuation_semaphore = asyncio.Semaphore(8)

        async def hydrate_valuation(row: Dict[str, Any]) -> Dict[str, Any]:
            required = ("marketCap", "peRatio", "pbRatio")
            if all(isinstance(row.get(key), (int, float)) for key in required):
                return {**row, "_valuationSource": source, "_valuationWarning": None}
            code = str(row["code"])
            async with valuation_semaphore:
                try:
                    snapshot, snapshot_source, snapshot_warning = await self._cached_fetch(
                        f"market:v1:screen-snapshot:{code}",
                        60,
                        lambda: self._fetch_screen_snapshot(code),
                    )
                except Exception as error:
                    return {
                        **row,
                        "_valuationSource": None,
                        "_valuationWarning": f"{code} 估值快照获取失败：{str(error)[:160]}",
                    }
            merged = dict(row)
            for key in ("price", "changePercent", "marketCap", "peRatio", "pbRatio", "dataTime"):
                if snapshot.get(key) is not None:
                    merged[key] = snapshot[key]
            merged["_valuationSource"] = snapshot_source
            merged["_valuationWarning"] = snapshot_warning
            return merged

        hydrated = await asyncio.gather(*(hydrate_valuation(row) for row in valuation_pool))
        await self._report(
            progress,
            f"已为 {len(valuation_pool)} 个预选候选补齐市值和估值，开始执行严格条件过滤",
        )
        eligible = [row for row in hydrated if (
            isinstance(row.get("marketCap"), (int, float)) and row["marketCap"] >= 5_000_000_000
            and isinstance(row.get("peRatio"), (int, float)) and 0 < row["peRatio"] <= 100
            and isinstance(row.get("pbRatio"), (int, float)) and 0 < row["pbRatio"] <= 15
        )]
        candidates = eligible[:max(safe_deep_limit, safe_limit * 4)]
        semaphore = asyncio.Semaphore(6)

        async def enrich(row: Dict[str, Any]) -> Dict[str, Any]:
            code = str(row["code"])
            async with semaphore:
                financial_result, bars_result = await asyncio.gather(
                    self._optional_fetch(
                        f"market:v3:financial:{code}", 21600, "financial_snapshot", "财务指标", code,
                    ),
                    self._optional_fetch(
                        f"market:v3:kline:{code}:120", 900, "daily_bars", "日 K", code, 120,
                    ),
                )
            financial, financial_source, financial_warning = financial_result
            bars, bars_source, bars_warning = bars_result
            technical = technical_summary(bars)
            components = {
                "quality": self._screen_metric(financial.get("roe"), 5, 25),
                "growth": self._screen_metric(
                    (float(financial.get("revenueYoY")) + float(financial.get("netProfitYoY"))) / 2,
                    -10,
                    40,
                ) if isinstance(financial.get("revenueYoY"), (int, float)) and isinstance(financial.get("netProfitYoY"), (int, float)) else None,
                "value": (
                    (self._screen_metric(row.get("peRatio"), 8, 60, True) or 0)
                    + (self._screen_metric(row.get("pbRatio"), 1, 10, True) or 0)
                ) / 2,
                "momentum": self._screen_metric(technical.get("return20d"), -15, 25),
                "risk": self._screen_metric(technical.get("maxDrawdown60d"), -30, -3),
            }
            weights = {
                "balanced": {"quality": .25, "growth": .2, "value": .2, "momentum": .2, "risk": .15},
                "quality": {"quality": .5, "growth": .15, "value": .15, "momentum": .05, "risk": .15},
                "growth": {"quality": .15, "growth": .5, "value": .1, "momentum": .15, "risk": .1},
                "value": {"quality": .2, "growth": .1, "value": .5, "momentum": .05, "risk": .15},
                "momentum": {"quality": .1, "growth": .1, "value": .05, "momentum": .55, "risk": .2},
            }[safe_style]
            score = sum((components[key] if components[key] is not None else 50) * weight for key, weight in weights.items())
            gaps = [key for key, value in components.items() if value is None]
            valuation_source = row.get("_valuationSource") or source
            return {
                **{key: value for key, value in row.items() if not key.startswith("_")},
                "score": round(score, 2),
                "scoreBreakdown": {key: round(value, 2) if value is not None else None for key, value in components.items()},
                "financial": financial,
                "technical": technical,
                "dataSources": {
                    "universe": source,
                    "snapshot": valuation_source,
                    **({"financial": financial_source} if financial_source else {}),
                    **({"dailyKline": bars_source, "technical": bars_source} if bars_source else {}),
                },
                "dataGaps": gaps,
                "warnings": [
                    item for item in (
                        row.get("_valuationWarning"), financial_warning, bars_warning,
                    ) if item
                ],
            }

        ranked = sorted(await asyncio.gather(*(enrich(row) for row in candidates)), key=lambda row: row["score"], reverse=True)
        await self._report(progress, f"已完成 {len(ranked)} 个候选的财务与趋势评分")
        stocks = ranked[:safe_limit]
        for rank, row in enumerate(stocks, start=1):
            row["rank"] = rank
        warnings = [item for item in (quant_warning, source_warning) if item]
        valuation_failure_count = sum(1 for row in hydrated if row.get("_valuationSource") is None)
        if valuation_failure_count:
            warnings.append(f"{valuation_failure_count} 个预选候选未取得完整估值快照，已排除")
        if len(eligible) < safe_limit:
            warnings.append("满足基础流动性、规模和估值条件的股票数量不足")
        if any(row["dataGaps"] for row in stocks):
            warnings.append("部分候选缺少财务或历史指标，缺失维度按中性分计入")
        return {
            "kind": "stock_screen",
            "engine": "snapshot_fallback",
            "status": "ok" if stocks else "unavailable",
            "style": safe_style,
            "asOf": now.isoformat(),
            "marketStatus": market_state(now),
            "criteria": {
                "universe": "A股全市场（不含 ST）",
                "minimumAmount": 50_000_000,
                "minimumMarketCap": 5_000_000_000,
                "peRange": [0, 100],
                "pbRange": [0, 15],
                "universeCount": len(universe),
                "prefilteredCount": len(prefiltered),
                "valuationCandidateCount": len(valuation_pool),
                "eligibleCount": len(eligible),
                "enrichedCount": len(ranked),
                "scorePolicy": "缺失维度按 50 分中性计入；排名是系统计算，不是投资建议",
            },
            "stocks": stocks,
            "dataSources": {
                "universe": source,
                "snapshot": (
                    stocks[0]["dataSources"].get("snapshot") if stocks else None
                ),
            },
            "warnings": list(dict.fromkeys(warnings)),
            "dataGaps": list(dict.fromkeys(gap for row in stocks for gap in row["dataGaps"])),
        }

    async def _sector_catalog(self, category: str) -> List[Dict[str, str]]:
        async with self._sector_catalog_locks[category]:
            try:
                rows, _, _ = await self._cached_fetch(
                    f"market:v2:sector-catalog:{category}",
                    86400,
                    lambda: self._fetch("sector_catalog", category),
                )
                if rows:
                    self._sector_catalog_memory[category] = rows
            except Exception:
                rows = self._sector_catalog_memory.get(category, [])

            output = [dict(row) for row in rows]
            names = {str(row.get("name") or "") for row in output}
            output.extend(
                dict(row)
                for row in KNOWN_SECTORS.get(category, [])
                if row["name"] not in names
            )
            return output

    async def resolve_sector(self, query: str) -> Tuple[Optional[Dict[str, str]], List[Dict[str, str]]]:
        matches: Dict[str, Dict[str, str]] = {}
        for category in ("industry", "concept"):
            rows = await self._sector_catalog(category)
            exact = [row for row in rows if row["name"] in query]
            for row in exact:
                matches[f"{row['kind']}:{row['code']}"] = row
            if category == "industry" and len(exact) == 1:
                return exact[0], []
        values = list(matches.values())
        if len(values) == 1:
            return values[0], []
        if len(values) > 1:
            industry = [item for item in values if item["kind"] == "industry"]
            if len(industry) == 1:
                return industry[0], []
            return None, values[:10]
        return None, []

    async def resolve_sector_names(self, names: List[str]) -> List[Dict[str, str]]:
        rows = await self._sector_catalog("industry")
        by_name = {str(row.get("name") or ""): row for row in rows}
        return [by_name[name] for name in names if name in by_name]

    @staticmethod
    def _breadth_ratio(snapshot: Dict[str, Any]) -> float:
        advancers = float(snapshot.get("advancers") or 0)
        decliners = float(snapshot.get("decliners") or 0)
        total = advancers + decliners
        return advancers / total if total else 0.5

    @staticmethod
    async def _report(progress: Optional[ProgressCallback], text: str) -> None:
        if progress:
            await progress(text)

    async def _publish_sector_scan_progress(self, text: str) -> None:
        if not self._sector_scan_progress_listeners:
            return
        await asyncio.gather(
            *(listener(text) for listener in tuple(self._sector_scan_progress_listeners)),
            return_exceptions=True,
        )

    async def _build_sector_scan(
        self,
        window_days: int,
        progress: Optional[ProgressCallback] = None,
    ) -> Dict[str, Any]:
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        try:
            snapshots, snapshot_source, snapshot_warning = await self._fetch(
                "sector_scan_snapshot",
                "industry",
            )
        except Exception as error:
            return {
                "kind": "sector_scan",
                "status": "unavailable",
                "universe": "industry",
                "asOf": now.isoformat(),
                "sectors": [],
                "warnings": [f"行业板块批量快照获取失败：{str(error)[:180]}"],
            }

        valid = [row for row in snapshots if row.get("name") and row.get("code")]
        await self._report(progress, f"已获取 {len(valid)} 个行业板块的行情快照")
        candidate_map: Dict[str, Dict[str, Any]] = {}

        def add_candidates(rows: List[Dict[str, Any]], count: int) -> None:
            for row in rows[:count]:
                candidate_map.setdefault(str(row["code"]), row)

        add_candidates(sorted(
            valid,
            key=lambda item: item.get("changePercent") if item.get("changePercent") is not None else -math.inf,
            reverse=True,
        ), 5)
        add_candidates(sorted(
            valid,
            key=lambda item: item.get("change5d") if item.get("change5d") is not None else -math.inf,
            reverse=True,
        ), 6)
        add_candidates(sorted(
            valid,
            key=lambda item: item.get("change10d") if item.get("change10d") is not None else -math.inf,
            reverse=True,
        ), 6)
        add_candidates(sorted(
            valid,
            key=lambda item: self._breadth_ratio(item),
            reverse=True,
        ), 4)
        add_candidates(sorted(
            valid,
            key=lambda item: item.get("netInflow10d") if item.get("netInflow10d") is not None else -math.inf,
            reverse=True,
        ), 4)
        candidates = list(candidate_map.values())[:20]
        await self._report(
            progress,
            f"根据当日、5 日和 10 日表现筛出 {len(candidates)} 个候选，开始计算 {window_days} 日趋势",
        )
        semaphore = asyncio.Semaphore(4)

        async def enrich(snapshot: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
            async with semaphore:
                bars, bars_source, bars_warning = await self._optional_fetch(
                    f"market:v3:sector-scan-kline:{snapshot['kind']}:{snapshot['code']}",
                    900,
                    "sector_bars",
                    f"{snapshot['name']}板块日 K",
                    snapshot["kind"],
                    snapshot["name"],
                    max(90, window_days + 1),
                )
            if not bars:
                return None, bars_warning
            technical = technical_summary(bars)
            if technical.get("return20d") is None:
                return None, f"{snapshot['name']}历史样本不足 20 个交易日"
            ma5 = technical.get("ma5")
            ma20 = technical.get("ma20")
            ma60 = technical.get("ma60")
            ma_aligned = all(value is not None for value in (ma5, ma20, ma60)) and ma5 > ma20 > ma60
            return5 = technical.get("return5d") if technical.get("return5d") is not None else 0
            return20 = technical.get("return20d") if technical.get("return20d") is not None else 0
            return60 = technical.get("return60d") if technical.get("return60d") is not None else 0
            volatility = technical.get("volatility20d") if technical.get("volatility20d") is not None else 40
            drawdown = technical.get("maxDrawdown60d") if technical.get("maxDrawdown60d") is not None else -30
            breadth_ratio = self._breadth_ratio(snapshot)
            strict_match = bool(
                ma_aligned
                and return20 > 0
                and return60 > 0
                and drawdown >= -15
            )
            near_match = bool(
                return20 > 0
                and ma5 is not None
                and ma20 is not None
                and ma5 >= ma20
            )
            score = (
                return5 * 0.15
                + return20 * 0.45
                + return60 * 0.25
                + (3 if ma_aligned else 0)
                + (breadth_ratio - 0.5) * 4
                + drawdown * 0.05
                - volatility * 0.03
            )
            is_ths = str(snapshot.get("kind") or "").endswith("_ths")
            snapshot_source_name = snapshot.get("source") or (
                "akshare-ths" if is_ths and snapshot_source == self.provider.name else snapshot_source
            )
            source = (
                "akshare-ths" if is_ths and bars_source == self.provider.name else bars_source
            )
            return {
                "category": snapshot["kind"],
                "code": snapshot["code"],
                "name": snapshot["name"],
                "score": round(score, 4),
                "matchLevel": "strict" if strict_match else "near" if near_match else "watch",
                "snapshot": {
                    key: snapshot.get(key)
                    for key in (
                        "price", "changePercent", "amount", "marketCap", "turnoverRate",
                        "netInflow", "change5d", "netInflow5d", "change10d",
                        "netInflow10d", "advancers", "decliners", "averagePrice",
                        "leader", "leaderPrice", "leaderChangePercent", "dataTime",
                    )
                    if snapshot.get(key) is not None
                },
                "breadthRatio": round(breadth_ratio, 4),
                "technical": technical,
                "history": {
                    "points": len(bars),
                    "from": bars[0].get("time"),
                    "to": bars[-1].get("time"),
                },
                "dataSources": {
                    "snapshot": snapshot_source_name,
                    **({"dailyKline": source, "technical": source} if source else {}),
                },
            }, bars_warning

        pending = [asyncio.create_task(enrich(candidate)) for candidate in candidates]
        results = []
        for completed, task in enumerate(asyncio.as_completed(pending), start=1):
            results.append(await task)
            if completed == len(pending) or completed % 4 == 0:
                await self._report(
                    progress,
                    f"已完成 {completed}/{len(pending)} 个候选板块的历史趋势计算",
                )
        enriched = [item for item, _ in results if item]
        strict = sorted(
            (item for item in enriched if item["matchLevel"] == "strict"),
            key=lambda item: item["score"],
            reverse=True,
        )
        near = sorted(
            (item for item in enriched if item["matchLevel"] == "near"),
            key=lambda item: item["score"],
            reverse=True,
        )
        watch = sorted(
            (item for item in enriched if item["matchLevel"] == "watch"),
            key=lambda item: item["score"],
            reverse=True,
        )
        ranked = (strict + near + watch)[:10]
        for index, item in enumerate(ranked, start=1):
            item["rank"] = index

        warnings = [warning for _, warning in results if warning]
        output_warnings = []
        if snapshot_warning:
            output_warnings.append(snapshot_warning)
        if len(strict) < min(5, len(ranked)):
            output_warnings.append("严格趋势条件命中较少，结果中包含接近条件的观察项")
        failed_count = len(candidates) - len(enriched)
        if failed_count:
            output_warnings.append(f"{failed_count} 个候选板块因历史数据缺失未参与排名")
        if warnings and not failed_count:
            output_warnings.append("部分候选板块历史数据使用了降级来源")
        result_sources = ranked[0].get("dataSources", {}) if ranked else {}
        if ranked:
            leaders = "、".join(item["name"] for item in ranked[:5])
            await self._report(
                progress,
                f"趋势排名已生成，当前前列候选为：{leaders}",
            )
        else:
            await self._report(progress, "趋势计算完成，但没有取得可用于排名的候选板块")
        return {
            "kind": "sector_scan",
            "status": "ok" if ranked else "unavailable",
            "universe": "industry",
            "asOf": now.isoformat(),
            "marketStatus": market_state(now),
            "criteria": {
                "trend": "steady_up",
                "windowDays": window_days,
                "description": "优先选择 MA5 > MA20 > MA60、20/60 日收益为正且 60 日最大回撤不超过 15% 的行业",
                "universeCount": len(valid),
                "candidateCount": len(candidates),
                "scannedCount": len(enriched),
                "strictMatchCount": len(strict),
            },
            "sectors": ranked,
            "dataSources": {
                "snapshot": result_sources.get("snapshot", snapshot_source),
                "dailyKline": result_sources.get("dailyKline", self.provider.name),
            },
            "warnings": list(dict.fromkeys(output_warnings)),
        }

    async def scan_sectors(
        self,
        limit: int = 5,
        window_days: int = 60,
        progress: Optional[ProgressCallback] = None,
    ) -> Dict[str, Any]:
        safe_limit = max(1, min(10, limit))
        safe_window = 20 if window_days == 20 else 60
        cache_key = f"market:v3:sector-scan:industry:{safe_window}"
        if progress:
            self._sector_scan_progress_listeners.append(progress)
        try:
            cached = await self.cache.get(cache_key)
            if isinstance(cached, dict) and cached.get("kind") == "sector_scan":
                await self._report(
                    progress,
                    f"已读取最近一次行业扫描结果，共覆盖 {(cached.get('criteria') or {}).get('universeCount', 0)} 个行业",
                )
                return {**cached, "sectors": list(cached.get("sectors") or [])[:safe_limit]}
            async with self._sector_scan_lock:
                cached = await self.cache.get(cache_key)
                if isinstance(cached, dict) and cached.get("kind") == "sector_scan":
                    await self._report(
                        progress,
                        f"已读取刚完成的行业扫描结果，共覆盖 {(cached.get('criteria') or {}).get('universeCount', 0)} 个行业",
                    )
                    return {**cached, "sectors": list(cached.get("sectors") or [])[:safe_limit]}
                result = await self._build_sector_scan(
                    safe_window,
                    self._publish_sector_scan_progress,
                )
                if result.get("status") != "ok":
                    stale = await self.cache.get_stale(cache_key, 24 * 60 * 60)
                    if isinstance(stale, dict) and stale.get("status") == "ok":
                        warnings = list(stale.get("warnings") or [])
                        warnings.append("实时板块扫描失败，当前展示本机最近一次成功结果，不得视为实时排名")
                        return {
                            **stale,
                            "stale": True,
                            "warnings": list(dict.fromkeys(warnings)),
                            "sectors": list(stale.get("sectors") or [])[:safe_limit],
                        }
                await self.cache.set(cache_key, result, 900)
                return {**result, "sectors": list(result.get("sectors") or [])[:safe_limit]}
        finally:
            if progress:
                try:
                    self._sector_scan_progress_listeners.remove(progress)
                except ValueError:
                    pass

    async def sector_context(
        self,
        category: str,
        code: str,
        name: str,
        daily_count: int = 120,
    ) -> Dict[str, Any]:
        async def fetch_parts(fetch_category: str, fetch_code: str) -> Tuple[Any, Any, Any]:
            return await asyncio.gather(
                self._optional_fetch(
                    f"market:v2:sector-snapshot:{fetch_category}:{fetch_code}",
                    30,
                    "sector_snapshot",
                    "板块快照",
                    fetch_category,
                    fetch_code,
                    name,
                ),
                self._optional_fetch(
                    f"market:v2:sector-kline:{fetch_category}:{fetch_code}:{daily_count}",
                    900,
                    "sector_bars",
                    "板块日 K",
                    fetch_category,
                    name,
                    daily_count,
                ),
                self._optional_fetch(
                    f"market:v2:sector-constituents:{fetch_category}:{fetch_code}",
                    60,
                    "sector_constituents",
                    "板块成分股",
                    fetch_category,
                    fetch_code,
                    name,
                ),
            )

        effective_category = category
        effective_code = code
        source_fallback_warning = None
        snapshot_result, bars_result, constituents_result = await fetch_parts(category, code)
        if (
            category in {"industry", "concept"}
            and not any((snapshot_result[0], bars_result[0], constituents_result[0]))
        ):
            try:
                alternate_catalog = await self.provider.sector_catalog(category)
            except Exception:
                alternate_catalog = []
            alternate = next(
                (
                    item for item in alternate_catalog
                    if item.get("kind") == f"{category}_ths" and item.get("name") == name
                ),
                None,
            )
            if alternate:
                alternate_results = await fetch_parts(alternate["kind"], alternate["code"])
                if any(result[0] for result in alternate_results):
                    snapshot_result, bars_result, constituents_result = alternate_results
                    effective_category = alternate["kind"]
                    effective_code = alternate["code"]
                    source_fallback_warning = (
                        f"{name}东方财富板块接口不可用，已自动切换至同花顺板块数据"
                    )

        snapshot, snapshot_source, snapshot_warning = snapshot_result
        bars, bars_source, bars_warning = bars_result
        constituents, constituents_source, constituents_warning = constituents_result
        proxy_warning = None
        if not snapshot and not constituents and name in KNOWN_SECTOR_BASKETS:
            proxy_provider = self.fallback_provider or self.provider
            proxy_results = []
            for code, _ in KNOWN_SECTOR_BASKETS[name]:
                try:
                    proxy_results.append(await proxy_provider.snapshot(code))
                except Exception as error:
                    proxy_results.append(error)
            constituents = [
                {
                    "code": code,
                    "name": item.get("name") or fallback_name,
                    "price": item.get("price"),
                    "changePercent": item.get("changePercent"),
                    "dataTime": item.get("dataTime"),
                }
                for (code, fallback_name), item in zip(KNOWN_SECTOR_BASKETS[name], proxy_results)
                if isinstance(item, dict) and item.get("changePercent") is not None
            ]
            proxy_changes = [float(item["changePercent"]) for item in constituents]
            if proxy_changes:
                sorted_proxy = sorted(
                    constituents,
                    key=lambda item: float(item["changePercent"]),
                    reverse=True,
                )
                snapshot = {
                    "changePercent": round(sum(proxy_changes) / len(proxy_changes), 4),
                    "advancers": sum(value > 0 for value in proxy_changes),
                    "decliners": sum(value < 0 for value in proxy_changes),
                    "leader": sorted_proxy[0]["name"],
                    "leaderPrice": sorted_proxy[0].get("price"),
                    "leaderChangePercent": sorted_proxy[0]["changePercent"],
                    "dataTime": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
                    "proxy": True,
                    "sampleSize": len(constituents),
                }
                snapshot_source = f"{proxy_provider.name}-sector-proxy"
                constituents_source = snapshot_source
                proxy_warning = (
                    f"{name}板块官方快照不可用，当前涨跌为 {len(constituents)} 只代表性成分股的等权估算"
                )
            else:
                proxy_warning = f"{name}板块官方快照和代表性成分股行情均不可用"
        if effective_category.endswith("_ths"):
            snapshot_source = "akshare-ths" if snapshot_source == self.provider.name else snapshot_source
            bars_source = "akshare-ths" if bars_source == self.provider.name else bars_source
            constituents_source = (
                "akshare-ths" if constituents_source == self.provider.name else constituents_source
            )
        changes = [
            item["changePercent"]
            for item in constituents
            if item.get("changePercent") is not None
        ]
        sorted_constituents = sorted(
            constituents,
            key=lambda item: item.get("changePercent") if item.get("changePercent") is not None else -math.inf,
            reverse=True,
        )
        warnings = [
            warning
            for warning in (
                source_fallback_warning,
                snapshot_warning,
                bars_warning,
                constituents_warning,
                proxy_warning,
            )
            if warning
        ]
        if not sorted_constituents and snapshot.get("leader"):
            sorted_constituents = [{
                "name": snapshot.get("leader"),
                "price": snapshot.get("leaderPrice"),
                "changePercent": snapshot.get("leaderChangePercent"),
            }]
        if snapshot.get("advancers") is not None and snapshot.get("decliners") is not None:
            breadth = {
                "advancers": int(snapshot.get("advancers") or 0),
                "decliners": int(snapshot.get("decliners") or 0),
                "unchanged": 0,
            }
        else:
            breadth = {
                "advancers": sum(value > 0 for value in changes),
                "decliners": sum(value < 0 for value in changes),
                "unchanged": sum(value == 0 for value in changes),
            }
        expected_constituents = breadth["advancers"] + breadth["decliners"] + breadth["unchanged"]
        constituents_partial = bool(
            sorted_constituents
            and expected_constituents
            and len(sorted_constituents) < expected_constituents
        )
        if constituents_partial:
            warnings.append(
                f"成分股榜单当前展示涨幅排序前 {len(sorted_constituents)} 只，不代表完整成分股列表"
            )
        data_sources = {
            key: source
            for key, source in {
                "snapshot": snapshot_source,
                "dailyKline": bars_source,
                "constituents": constituents_source,
                "technical": bars_source,
            }.items()
            if source
        }
        status = "ok" if snapshot or bars or constituents else "unavailable"
        return {
            "kind": "sector",
            "status": status,
            "category": effective_category,
            "code": effective_code,
            "name": name,
            "asOf": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            "marketStatus": market_state(datetime.now(ZoneInfo("Asia/Shanghai"))),
            "snapshot": snapshot,
            "dailyBars": bars,
            "technical": technical_summary(bars),
            "breadth": breadth,
            "leaders": sorted_constituents[:5],
            "advancingConstituents": [
                item for item in sorted_constituents
                if item.get("changePercent") is not None and item["changePercent"] > 0
            ][:20],
            "laggards": [] if constituents_partial else list(reversed(sorted_constituents[-5:])),
            "dataSources": data_sources,
            "stale": any("本机最近一次成功缓存" in warning for warning in warnings),
            "warnings": warnings,
        }

    async def index_context(
        self,
        code: str,
        name: str,
        category: str,
        daily_count: int = 120,
    ) -> Dict[str, Any]:
        snapshot_result, bars_result = await asyncio.gather(
            self._optional_fetch(
                f"market:v2:index-snapshot:{code}",
                30,
                "index_snapshot",
                "指数快照",
                code,
                category,
            ),
            self._optional_fetch(
                f"market:v2:index-kline:{code}:{daily_count}",
                900,
                "index_bars",
                "指数日 K",
                code,
                daily_count,
            ),
        )
        snapshot, snapshot_source, snapshot_warning = snapshot_result
        bars, bars_source, bars_warning = bars_result
        return {
            "kind": "index",
            "status": "ok" if snapshot or bars else "unavailable",
            "code": code,
            "name": name,
            "asOf": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            "marketStatus": market_state(datetime.now(ZoneInfo("Asia/Shanghai"))),
            "snapshot": snapshot,
            "dailyBars": bars,
            "technical": technical_summary(bars),
            "dataSources": {
                key: source
                for key, source in {
                    "snapshot": snapshot_source,
                    "dailyKline": bars_source,
                    "technical": bars_source,
                }.items()
                if source
            },
            "stale": any(
                "本机最近一次成功缓存" in warning
                for warning in (snapshot_warning, bars_warning)
                if warning
            ),
            "warnings": [warning for warning in (snapshot_warning, bars_warning) if warning],
        }

    async def trading_calendar(self, days_ahead: int = 10) -> Dict[str, Any]:
        tz = ZoneInfo("Asia/Shanghai")
        today = datetime.now(tz).date()

        def describe(day, trading: set) -> Dict[str, Any]:
            iso = day.isoformat()
            return {
                "date": iso,
                "weekday": WEEKDAY_NAMES[day.weekday()],
                "isTradingDay": iso in trading,
            }

        try:
            dates, source, _ = await self._cached_fetch(
                "market:v3:trade-calendar",
                6 * 60 * 60,
                lambda: self._fetch("trade_calendar"),
            )
        except Exception as error:
            return {
                "status": "unavailable",
                "asOf": today.isoformat(),
                "error": str(error)[:200],
            }
        trading = set(dates)
        next_trading = None
        for offset in range(1, days_ahead + 1):
            candidate = today + timedelta(days=offset)
            if candidate.isoformat() in trading:
                next_trading = candidate
                break
        return {
            "status": "ok",
            "asOf": today.isoformat(),
            "timezone": "Asia/Shanghai",
            "source": source,
            "today": describe(today, trading),
            "tomorrow": describe(today + timedelta(days=1), trading),
            "nextTradingDay": (
                {
                    "date": next_trading.isoformat(),
                    "weekday": WEEKDAY_NAMES[next_trading.weekday()],
                }
                if next_trading
                else None
            ),
        }

    async def market_overview(self) -> Dict[str, Any]:
        try:
            overview, source, warning = await self._cached_fetch(
                "market:v2:overview",
                30,
                lambda: self._fetch("market_overview"),
            )
            return {
                "kind": "market",
                "status": "ok",
                "source": source,
                "marketStatus": market_state(datetime.now(ZoneInfo("Asia/Shanghai"))),
                **overview,
                "stale": bool(warning and "本机最近一次成功缓存" in warning),
                "warnings": [warning] if warning else [],
            }
        except Exception as error:
            return {
                "kind": "market",
                "status": "unavailable",
                "source": self.provider.name,
                "error": str(error)[:500],
                "warnings": ["全市场行情暂时不可用"],
            }

    @staticmethod
    def _is_stale(data_time: str, now: datetime, state: str) -> bool:
        if state != "trading" or not data_time:
            return False
        try:
            parsed = datetime.fromisoformat(data_time)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=now.tzinfo)
            return (now - parsed).total_seconds() > 60
        except ValueError:
            return True

    async def close(self) -> None:
        providers = []
        for provider in (
            self.provider,
            self.fallback_provider,
            self.universe_fallback_provider,
            self.professional_provider,
            self.announcement_provider,
        ):
            if provider and all(item is not provider for item in providers):
                providers.append(provider)
        for provider in providers:
            await provider.close()
        await self.cache.close()
