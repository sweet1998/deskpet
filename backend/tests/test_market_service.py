import asyncio
from datetime import datetime

import pytest

from app.cache import TTLCache
from app.market.providers.base import MarketProvider
from app.market.providers.eastmoney import map_symbol
from app.market.service import MarketService, search_terms, technical_summary


class FakeProvider(MarketProvider):
    name = "fake-market"

    def __init__(self):
        self.snapshot_calls = 0
        self.sector_bars_calls = 0

    async def search(self, query):
        if query == "平安":
            return [
                {"code": "SZ.000001", "name": "平安银行", "market": "深市"},
                {"code": "SH.601318", "name": "中国平安", "market": "沪市"},
            ]
        return []

    async def snapshot(self, code):
        self.snapshot_calls += 1
        return {
            "code": code,
            "name": "贵州茅台",
            "market": "沪市",
            "price": 1500.0,
            "changePercent": 1.2,
            "dataTime": "2026-07-17T10:00:00+08:00",
            "peRatio": 22.1,
            "pbRatio": 8.2,
            "marketCap": 1880000000000,
        }

    async def daily_bars(self, code, count):
        return [{"time": "2026-07-16", "close": 1480.0}]

    async def sector_scan_snapshot(self, category):
        assert category == "industry"
        return [
            {
                "kind": "industry_ths",
                "code": f"88{index:04d}",
                "name": f"行业{letter}",
                "changePercent": 3 - index * 0.3,
                "netInflow": 20 - index,
                "advancers": 20 - index,
                "decliners": 2 + index,
            }
            for index, letter in enumerate("ABCDEF")
        ]

    async def sector_catalog(self, category):
        assert category == "industry"
        return [
            {"kind": "industry", "code": "BK1036", "name": "半导体"},
            {"kind": "industry", "code": "BK0737", "name": "软件开发"},
        ]

    async def sector_bars(self, category, name, count):
        self.sector_bars_calls += 1
        slope = {"行业A": 1.0, "行业B": 0.8, "行业C": 0.6, "行业D": 0.3, "行业E": -0.1, "行业F": -0.3}[name]
        return [
            {"time": f"day-{index:03d}", "close": 100 + index * slope}
            for index in range(count)
        ]


class FailingProvider(FakeProvider):
    name = "failing-primary"

    async def snapshot(self, code):
        raise RuntimeError("snapshot failed")

    async def daily_bars(self, code, count):
        raise RuntimeError("bars failed")


class SlowSectorProvider(FakeProvider):
    async def sector_bars(self, category, name, count):
        await asyncio.sleep(0.01)
        return await super().sector_bars(category, name, count)


class FailingSectorCatalogProvider(FakeProvider):
    async def sector_catalog(self, category):
        raise RuntimeError("sector catalog failed")


class CalendarProvider(FakeProvider):
    async def trade_calendar(self):
        return ["2026-07-24", "2026-07-27", "2026-07-28"]


class FailingCalendarProvider(FakeProvider):
    async def trade_calendar(self):
        raise RuntimeError("calendar failed")


class FailingSectorDataProvider(FakeProvider):
    async def sector_snapshot(self, category, code, name):
        raise RuntimeError("sector snapshot failed")

    async def sector_bars(self, category, name, count):
        raise RuntimeError("sector bars failed")

    async def sector_constituents(self, category, code, name):
        raise RuntimeError("sector constituents failed")


class PartialSectorProvider(FakeProvider):
    name = "akshare-eastmoney"

    async def sector_snapshot(self, category, code, name):
        return {"changePercent": -4.03, "advancers": 6, "decliners": 273}

    async def sector_bars(self, category, name, count):
        return [{"time": "2026-07-23", "close": 1200}]

    async def sector_constituents(self, category, code, name):
        return [
            {"code": "SH.600538", "name": "国发股份", "changePercent": 6.95},
            {"code": "SZ.300639", "name": "凯普生物", "changePercent": 4.88},
        ]


def test_a_share_code_mapping():
    assert map_symbol("600519") == "SH.600519"
    assert map_symbol("000001") == "SZ.000001"
    assert map_symbol("830799") == "BJ.830799"
    assert map_symbol("123") is None


def test_search_term_cleanup():
    assert search_terms("请帮我分析一下贵州茅台走势") == ["贵州茅台"]
    assert search_terms("分析茅台的营收和利润") == ["茅台"]


@pytest.mark.asyncio
async def test_market_context_and_cache():
    provider = FakeProvider()
    service = MarketService(provider, TTLCache())
    first = await service.context("分析 600519", 120)
    second = await service.context("分析 600519", 120)

    assert first.status == "ok"
    assert first.securities[0].code == "SH.600519"
    assert first.securities[0].dailyBars[0].close == 1480.0
    assert second.status == "ok"
    assert provider.snapshot_calls == 1


@pytest.mark.asyncio
async def test_ambiguous_name_requires_confirmation():
    service = MarketService(FakeProvider(), TTLCache())
    result = await service.context("平安", 120)
    assert result.status == "ambiguous"
    assert len(result.candidates) == 2


@pytest.mark.asyncio
async def test_resolve_sector_names_uses_standard_industry_catalog():
    service = MarketService(FakeProvider(), TTLCache())

    result = await service.resolve_sector_names(["半导体", "软件开发", "不存在"])

    assert result == [
        {"kind": "industry", "code": "BK1036", "name": "半导体"},
        {"kind": "industry", "code": "BK0737", "name": "软件开发"},
    ]


@pytest.mark.asyncio
async def test_known_sector_resolves_when_remote_catalog_is_unavailable():
    service = MarketService(FailingSectorCatalogProvider(), TTLCache())

    result, candidates = await service.resolve_sector("今天白酒行情怎么样")

    assert result == {"kind": "industry_ths", "code": "881273", "name": "白酒"}
    assert candidates == []


@pytest.mark.asyncio
async def test_known_sector_uses_disclosed_constituent_proxy_when_board_data_fails():
    fallback = FakeProvider()
    service = MarketService(FailingSectorDataProvider(), TTLCache(), fallback)

    result = await service.sector_context("industry_ths", "881273", "白酒")

    assert result["status"] == "ok"
    assert result["snapshot"]["proxy"] is True
    assert result["snapshot"]["sampleSize"] == 5
    assert result["snapshot"]["changePercent"] == 1.2
    assert result["dataSources"]["snapshot"] == "fake-market-sector-proxy"
    assert any("代表性成分股的等权估算" in warning for warning in result["warnings"])


@pytest.mark.asyncio
async def test_sector_context_prefers_full_snapshot_breadth_over_partial_rankings():
    service = MarketService(PartialSectorProvider(), TTLCache())

    result = await service.sector_context("concept_ths", "308014", "创新药")

    assert result["breadth"] == {"advancers": 6, "decliners": 273, "unchanged": 0}
    assert result["dataSources"]["constituents"] == "akshare-ths"
    assert result["leaders"][0]["name"] == "国发股份"
    assert [item["name"] for item in result["advancingConstituents"]] == ["国发股份", "凯普生物"]
    assert result["laggards"] == []
    assert any("不代表完整成分股列表" in warning for warning in result["warnings"])


@pytest.mark.asyncio
async def test_market_uses_fallback_per_data_section():
    service = MarketService(FailingProvider(), TTLCache(), FakeProvider())
    result = await service.context("600519", 120)

    assert result.status == "ok"
    security = result.securities[0]
    assert security.dataSources["snapshot"] == "fake-market"
    assert security.dataSources["dailyKline"] == "fake-market"
    assert any("兜底" in warning for warning in security.warnings)


@pytest.mark.asyncio
async def test_market_is_unavailable_when_primary_and_fallback_snapshot_fail():
    service = MarketService(FailingProvider(), TTLCache(), FailingProvider())
    result = await service.context("600519", 120)
    assert result.status == "unavailable"
    assert "snapshot failed" in (result.error or "")


@pytest.mark.asyncio
async def test_market_uses_explicitly_stale_local_cache_when_all_live_sources_fail():
    cache = TTLCache()
    await cache.set("market:v2:snapshot:SH.600519", {
        "value": {
            "code": "SH.600519",
            "name": "贵州茅台",
            "market": "沪市",
            "price": 1490.0,
            "changePercent": -0.5,
            "dataTime": "2026-07-21T14:00:00+08:00",
        },
        "source": "cached-market",
        "warning": None,
        "cachedAt": "2026-07-21T14:00:01+08:00",
    }, 0)
    service = MarketService(FailingProvider(), cache, FailingProvider())

    result = await service.context("600519", 120)

    assert result.status == "ok"
    assert result.securities[0].price == 1490.0
    assert result.securities[0].stale is True
    assert any("本机最近一次成功缓存" in warning for warning in result.securities[0].warnings)


def test_technical_summary_requires_enough_history():
    short = technical_summary([{"close": 10 + index} for index in range(5)])
    assert short["return5d"] is None
    assert short["ma5"] == 12.0
    assert short["volatility20d"] is None
    assert short["maxDrawdown60d"] is None

    complete = technical_summary([{"close": 100 + index} for index in range(61)])
    assert complete["return5d"] is not None
    assert complete["return60d"] == 60.0
    assert complete["ma60"] is not None
    assert complete["volatility20d"] is not None
    assert complete["maxDrawdown60d"] == 0.0


@pytest.mark.asyncio
async def test_sector_scan_ranks_trends_and_reuses_cache():
    provider = FakeProvider()
    service = MarketService(provider, TTLCache())
    progress = []

    async def report(text):
        progress.append(text)

    first = await service.scan_sectors(limit=3, window_days=60, progress=report)
    calls_after_first = provider.sector_bars_calls
    first_progress_count = len(progress)
    second = await service.scan_sectors(limit=2, window_days=60, progress=report)

    assert first["status"] == "ok"
    assert [item["name"] for item in first["sectors"]] == ["行业A", "行业B", "行业C"]
    assert first["sectors"][0]["matchLevel"] == "strict"
    assert first["criteria"]["universeCount"] == 6
    assert "dailyBars" not in str(first)
    assert [item["name"] for item in second["sectors"]] == ["行业A", "行业B"]
    assert provider.sector_bars_calls == calls_after_first
    assert any("已获取 6 个行业板块" in item for item in progress[:first_progress_count])
    assert any("已完成 4/6" in item for item in progress[:first_progress_count])
    assert any("趋势排名已生成" in item for item in progress[:first_progress_count])
    assert progress[first_progress_count:] == ["已读取最近一次行业扫描结果，共覆盖 6 个行业"]


@pytest.mark.asyncio
async def test_sector_scan_broadcasts_inflight_background_progress_to_waiting_request():
    service = MarketService(SlowSectorProvider(), TTLCache())
    background = asyncio.create_task(service.scan_sectors(limit=3, window_days=60))
    await asyncio.sleep(0)
    progress = []

    async def report(text):
        progress.append(text)

    foreground = await service.scan_sectors(limit=3, window_days=60, progress=report)
    await background

    assert foreground["status"] == "ok"
    assert any("已完成" in item for item in progress)
    assert any("趋势排名已生成" in item for item in progress)


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 7, 24, 10, 0, tzinfo=tz)


@pytest.mark.asyncio
async def test_trading_calendar_reports_today_tomorrow_and_next_trading_day(monkeypatch):
    monkeypatch.setattr("app.market.service.datetime", _FrozenDatetime)
    service = MarketService(CalendarProvider(), TTLCache())

    result = await service.trading_calendar()

    assert result["status"] == "ok"
    assert result["asOf"] == "2026-07-24"
    assert result["today"] == {"date": "2026-07-24", "weekday": "星期五", "isTradingDay": True}
    assert result["tomorrow"] == {"date": "2026-07-25", "weekday": "星期六", "isTradingDay": False}
    assert result["nextTradingDay"] == {"date": "2026-07-27", "weekday": "星期一"}
    assert result["source"] == "fake-market"


@pytest.mark.asyncio
async def test_trading_calendar_returns_unavailable_when_provider_fails(monkeypatch):
    monkeypatch.setattr("app.market.service.datetime", _FrozenDatetime)
    service = MarketService(FailingCalendarProvider(), TTLCache())

    result = await service.trading_calendar()

    assert result["status"] == "unavailable"
    assert result["asOf"] == "2026-07-24"
    assert "calendar failed" in result["error"]
