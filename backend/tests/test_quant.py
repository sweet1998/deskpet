from datetime import date, timedelta

import pytest

from app.cache import TTLCache
from app.market.service import MarketService
from app.quant.factors import FactorEngine
from app.quant.repository import QuantRepository


class UnusedProvider:
    name = "unused"


class ReadyQuant:
    async def status(self):
        return {"instruments": 5533, "trading_days": 130}

    async def screen(self, style, limit, as_of=None):
        stocks = [{
            "rank": index + 1,
            "code": f"SH.600{index:03d}",
            "name": f"候选{index + 1}",
            "price": 10 + index,
            "score": 90.0 - index / 10,
            "quality": 90.0 - index / 10,
            "growth": 70.0,
            "value": 65.0,
            "momentum": 80.0,
            "risk": 75.0,
            "coverage": 1.0,
            "confidence": "high",
        } for index in range(min(limit, 100))]
        return {
            "kind": "factor_screen",
            "status": "ok",
            "style": style,
            "asOf": "2026-07-28",
            "factorVersion": "test-v1",
            "universeCount": 1200,
            "criteria": {"pointInTime": True, "industryNeutralized": True},
            "stocks": stocks,
            "warnings": [],
        }


@pytest.mark.asyncio
async def test_repository_financial_query_is_point_in_time(tmp_path):
    repository = QuantRepository(str(tmp_path / "quant.duckdb"))
    await repository.start()
    await repository.upsert_financial_periods([
        {
            "instrumentId": "SH.600519",
            "reportDate": "2025-12-31",
            "announcedAt": "2026-03-30",
            "roe": 20.0,
            "sourceRecordId": "older",
            "source": "test",
            "ingestedAt": "2026-07-28T10:00:00+08:00",
        },
        {
            "instrumentId": "SH.600519",
            "reportDate": "2026-03-31",
            "announcedAt": "2026-04-30",
            "roe": 25.0,
            "sourceRecordId": "future-at-cutoff",
            "source": "test",
            "ingestedAt": "2026-07-28T10:00:00+08:00",
        },
    ])

    before_announcement = await repository.financials_as_of("2026-04-15")
    after_announcement = await repository.financials_as_of("2026-05-01")

    assert before_announcement["SH.600519"]["roe"] == 20.0
    assert after_announcement["SH.600519"]["roe"] == 25.0


@pytest.mark.asyncio
async def test_factor_engine_discloses_missing_factor_coverage(tmp_path):
    repository = QuantRepository(str(tmp_path / "quant.duckdb"))
    await repository.start()
    ingested_at = "2026-07-28T10:00:00+08:00"
    instruments = [{
        "instrumentId": f"SH.60000{index}",
        "symbol": f"60000{index}",
        "name": f"样本{index}",
        "industry": "测试行业",
        "market": "沪市",
        "listDate": "2020-01-01",
        "listStatus": "L",
        "source": "test",
        "ingestedAt": ingested_at,
    } for index in range(6)]
    await repository.upsert_instruments(instruments)
    start = date(2026, 1, 1)
    prices = []
    for day in range(130):
        trade_date = (start + timedelta(days=day)).isoformat()
        for index, instrument in enumerate(instruments):
            close = 10 + day * (0.01 + index * 0.002)
            prices.append({
                "instrumentId": instrument["instrumentId"],
                "tradeDate": trade_date,
                "open": close - 0.01,
                "high": close + 0.05,
                "low": close - 0.05,
                "close": close,
                "preClose": close - 0.01,
                "pctChange": 0.1 + index * 0.01,
                "volume": 1_000_000,
                "amount": 100_000_000 + index * 1_000_000,
                "source": "test",
                "ingestedAt": ingested_at,
            })
    await repository.upsert_daily_prices(prices)
    engine = FactorEngine(repository)

    balanced = await engine.screen("2026-05-10", "balanced", 5)
    quality = await engine.screen("2026-05-10", "quality", 5)

    assert balanced["status"] == "ok"
    assert balanced["criteria"]["missingDataPolicy"].startswith("缺失因子不计分")
    assert all(item["coverage"] == 0.35 for item in balanced["stocks"])
    assert all(item["quality"] is None and item["growth"] is None for item in balanced["stocks"])
    assert quality["status"] == "unavailable"


@pytest.mark.asyncio
async def test_market_screen_prefers_ready_multi_factor_engine():
    market = MarketService(
        UnusedProvider(),
        TTLCache(None, None),
        quant_service=ReadyQuant(),
    )
    progress = []

    async def report(text):
        progress.append(text)

    result = await market.screen_stocks("balanced", 5, report)

    assert result["kind"] == "stock_screen"
    assert result["engine"] == "layered_multi_factor"
    assert result["criteria"]["pointInTime"] is True
    assert result["stocks"][0]["scoreBreakdown"]["quality"] == 90.0
    assert result["analysisFunnel"] == {
        "universeCount": 5533,
        "factorEligibleCount": 1200,
        "shortlistCount": 100,
        "deepAnalyzedCount": 20,
        "finalCount": 5,
    }
    assert len(result["deepCandidates"]) == 20
    assert len(result["stocks"]) == 5
    assert any("量化因子引擎已完成" in item for item in progress)
    assert any("财务、估值与因子二次评分" in item for item in progress)
