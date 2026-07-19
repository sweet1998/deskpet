import pytest

from app.cache import TTLCache
from app.market.providers.base import MarketProvider
from app.market.providers.eastmoney import map_symbol
from app.market.service import MarketService, search_terms, technical_summary


class FakeProvider(MarketProvider):
    name = "fake-market"

    def __init__(self):
        self.snapshot_calls = 0

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


class FailingProvider(FakeProvider):
    name = "failing-primary"

    async def snapshot(self, code):
        raise RuntimeError("snapshot failed")

    async def daily_bars(self, code, count):
        raise RuntimeError("bars failed")


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
