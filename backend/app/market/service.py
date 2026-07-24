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
ProgressCallback = Callable[[str], Awaitable[None]]
STOP_WORDS = (
    "请", "帮我", "分析一下", "分析", "看看", "研究", "怎么样", "如何", "走势", "股票", "A股",
    "最近", "近期", "当前", "现在", "今天", "行情", "趋势", "价格", "股价", "基本面", "财报", "估值",
    "风险", "原因", "为什么", "对比", "比较", "多少钱", "表现", "营收", "利润", "现金流", "负债",
    "成长性", "市盈率", "市净率", "贵不贵", "便宜", "支撑", "压力", "展望", "的", "好吗", "好不好",
    "还好吗", "咋回事", "怎么了", "整体如何", "热不热", "弱不弱", "有啥变化", "什么情况",
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
    def __init__(
        self,
        provider: MarketProvider,
        cache: TTLCache,
        fallback_provider: Optional[MarketProvider] = None,
    ):
        self.provider = provider
        self.fallback_provider = fallback_provider
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
            "stale": bool(snapshot_warning and "本机最近一次成功缓存" in snapshot_warning)
            or self._is_stale(snapshot.get("dataTime", ""), now, state),
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
        if category.endswith("_ths"):
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
            for warning in (snapshot_warning, bars_warning, constituents_warning, proxy_warning)
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
        await self.provider.close()
        if self.fallback_provider and self.fallback_provider is not self.provider:
            await self.fallback_provider.close()
        await self.cache.close()
