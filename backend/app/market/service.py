import asyncio
from datetime import datetime, time as clock_time
import math
import re
from statistics import stdev
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from ..cache import TTLCache
from ..models import MarketContextResponse, SecurityContext
from .providers.base import MarketProvider
from .providers.eastmoney import map_symbol


CODE_PATTERN = re.compile(r"(?<!\d)(\d{6})(?!\d)")
STOP_WORDS = (
    "请", "帮我", "分析一下", "分析", "看看", "研究", "怎么样", "如何", "走势", "股票", "A股",
    "最近", "近期", "当前", "现在", "今天", "行情", "趋势", "价格", "股价", "基本面", "财报", "估值",
    "风险", "原因", "为什么", "对比", "比较", "多少钱", "表现", "营收", "利润", "现金流", "负债",
    "成长性", "市盈率", "市净率", "贵不贵", "便宜", "支撑", "压力", "展望", "的",
)


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
    def __init__(
        self,
        provider: MarketProvider,
        cache: TTLCache,
        fallback_provider: Optional[MarketProvider] = None,
    ):
        self.provider = provider
        self.fallback_provider = fallback_provider
        self.cache = cache

    @staticmethod
    def _has_data(value: Any) -> bool:
        return value is not None and value != {} and value != []

    async def _fetch(
        self,
        method: str,
        *args: Any,
    ) -> Tuple[Any, str, Optional[str]]:
        errors = []
        providers = [self.provider]
        if self.fallback_provider and self.fallback_provider.name != self.provider.name:
            providers.append(self.fallback_provider)
        for index, provider in enumerate(providers):
            try:
                value = await getattr(provider, method)(*args)
                if not self._has_data(value):
                    raise RuntimeError("没有返回数据")
                warning = None
                if index:
                    warning = f"{method} 主数据源失败，已使用 {provider.name} 兜底"
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
        value, source, warning = await loader()
        await self.cache.set(key, {
            "value": value,
            "source": source,
            "warning": warning,
        }, ttl)
        return value, source, warning

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
            empty_value: Any = [] if method == "daily_bars" else {}
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

        matches: Dict[str, Dict[str, str]] = {}
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
            selected = exact or rows[:5]
            for row in selected:
                matches[row["code"]] = row
            if exact:
                break
        values = list(matches.values())
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
    ) -> SecurityContext:
        code = item["code"]
        snapshot_task = self._cached_fetch(
            f"market:v2:snapshot:{code}",
            15,
            lambda: self._fetch("snapshot", code),
        )
        bars_task = self._optional_fetch(
            f"market:v2:kline:{code}:{daily_count}",
            900,
            "daily_bars",
            "日 K",
            code,
            daily_count,
        )
        profile_task = self._optional_fetch(
            f"market:v2:profile:{code}",
            86400,
            "company_profile",
            "公司资料",
            code,
        )
        financial_task = self._optional_fetch(
            f"market:v2:financial:{code}",
            21600,
            "financial_snapshot",
            "财务指标",
            code,
        )
        snapshot_result, bars_result, profile_result, financial_result = await asyncio.gather(
            snapshot_task,
            bars_task,
            profile_task,
            financial_task,
        )
        snapshot, snapshot_source, snapshot_warning = snapshot_result
        bars, bars_source, bars_warning = bars_result
        profile, profile_source, profile_warning = profile_result
        financial, financial_source, financial_warning = financial_result
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
                "technical": bars_source,
            }.items()
            if source
        }
        snapshot.update({
            "dailyBars": bars,
            "profile": profile,
            "financial": financial,
            "technical": technical_summary(bars),
            "dataSources": data_sources,
            "warnings": warnings,
            "marketStatus": state,
            "stale": self._is_stale(snapshot.get("dataTime", ""), now, state),
        })
        return SecurityContext.model_validate(snapshot)

    async def resolve_securities(
        self,
        query: str,
    ) -> Tuple[List[Dict[str, str]], List[Dict[str, str]], List[str]]:
        return await self._resolve(query)

    async def context(self, query: str, daily_count: int = 120) -> MarketContextResponse:
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
                self._security_context(item, daily_count, now, state, resolve_warnings)
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

    async def resolve_sector(self, query: str) -> Tuple[Optional[Dict[str, str]], List[Dict[str, str]]]:
        matches: Dict[str, Dict[str, str]] = {}
        for category in ("industry", "concept"):
            try:
                rows, _, _ = await self._cached_fetch(
                    f"market:v2:sector-catalog:{category}",
                    86400,
                    lambda category=category: self._fetch("sector_catalog", category),
                )
            except Exception:
                continue
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

    async def sector_context(
        self,
        category: str,
        code: str,
        name: str,
        daily_count: int = 120,
    ) -> Dict[str, Any]:
        snapshot_task = self._optional_fetch(
            f"market:v2:sector-snapshot:{category}:{code}",
            30,
            "sector_snapshot",
            "板块快照",
            category,
            code,
            name,
        )
        bars_task = self._optional_fetch(
            f"market:v2:sector-kline:{category}:{code}:{daily_count}",
            900,
            "sector_bars",
            "板块日 K",
            category,
            name,
            daily_count,
        )
        constituents_task = self._optional_fetch(
            f"market:v2:sector-constituents:{category}:{code}",
            60,
            "sector_constituents",
            "板块成分股",
            category,
            code,
            name,
        )
        snapshot_result, bars_result, constituents_result = await asyncio.gather(
            snapshot_task,
            bars_task,
            constituents_task,
        )
        snapshot, snapshot_source, snapshot_warning = snapshot_result
        bars, bars_source, bars_warning = bars_result
        constituents, constituents_source, constituents_warning = constituents_result
        if category.endswith("_ths"):
            snapshot_source = "akshare-ths" if snapshot_source == self.provider.name else snapshot_source
            bars_source = "akshare-ths" if bars_source == self.provider.name else bars_source
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
            for warning in (snapshot_warning, bars_warning, constituents_warning)
            if warning
        ]
        if not sorted_constituents and snapshot.get("leader"):
            sorted_constituents = [{
                "name": snapshot.get("leader"),
                "price": snapshot.get("leaderPrice"),
                "changePercent": snapshot.get("leaderChangePercent"),
            }]
        if not changes and snapshot.get("advancers") is not None:
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
            "category": category,
            "code": code,
            "name": name,
            "asOf": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            "marketStatus": market_state(datetime.now(ZoneInfo("Asia/Shanghai"))),
            "snapshot": snapshot,
            "dailyBars": bars,
            "technical": technical_summary(bars),
            "breadth": breadth,
            "leaders": sorted_constituents[:5],
            "laggards": list(reversed(sorted_constituents[-5:])),
            "dataSources": data_sources,
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
            "warnings": [warning for warning in (snapshot_warning, bars_warning) if warning],
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
        await self.provider.close()
        if self.fallback_provider and self.fallback_provider is not self.provider:
            await self.fallback_provider.close()
        await self.cache.close()
