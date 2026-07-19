import asyncio
from datetime import date, timedelta

import pytest

from app.market.providers.akshare_provider import AkshareProvider


class FakeFrame:
    def __init__(self, rows):
        self.rows = rows
        self.empty = not rows

    def to_dict(self, orient):
        assert orient == "records"
        return self.rows


class FakeAkshare:
    def __init__(self):
        self.spot_calls = 0

    def stock_zh_a_spot_em(self):
        self.spot_calls += 1
        return FakeFrame([
            {
                "代码": "600519",
                "名称": "贵州茅台",
                "最新价": 1500,
                "涨跌幅": 1.25,
                "市盈率-动态": 22.1,
                "市净率": 8.2,
                "总市值": 1_880_000_000_000,
                "流通市值": 1_870_000_000_000,
            },
            {"代码": "830799", "名称": "艾融软件", "最新价": 25.2},
        ])

    def stock_zh_a_hist(self, **kwargs):
        assert kwargs["symbol"] == "600519"
        assert kwargs["adjust"] == "qfq"
        start = date(2026, 1, 1)
        return FakeFrame([
            {
                "日期": start + timedelta(days=index),
                "开盘": 1400 + index,
                "收盘": 1401 + index,
                "最高": 1402 + index,
                "最低": 1399 + index,
                "成交量": 10000 + index,
            }
            for index in range(70)
        ])

    def stock_individual_info_em(self, symbol):
        assert symbol == "600519"
        return FakeFrame([
            {"item": "行业", "value": "白酒"},
            {"item": "上市时间", "value": 20010827},
            {"item": "总股本", "value": 1_256_197_800},
            {"item": "流通股", "value": 1_256_197_800},
            {"item": "流通市值", "value": float("nan")},
        ])

    def stock_financial_analysis_indicator_em(self, **kwargs):
        assert kwargs == {"symbol": "600519.SH", "indicator": "按报告期"}
        return FakeFrame([
            {"REPORT_DATE": "2025-12-31", "EPSJB": 60},
            {
                "REPORT_DATE": "2026-03-31",
                "EPSJB": 15.2,
                "TOTALOPERATEREVE": 50_000_000_000,
                "TOTALOPERATEREVETZ": 8.1,
                "PARENTNETPROFIT": 25_000_000_000,
                "PARENTNETPROFITTZ": 9.2,
                "ROEJQ": 12.5,
                "XSMLL": 91.0,
                "XSJLL": 52.0,
                "ZCFZL": 18.0,
                "MGJYXJJE": 16.3,
            },
        ])

    def stock_board_industry_name_em(self):
        return FakeFrame([{"板块代码": "BK0896", "板块名称": "白酒"}])

    def stock_board_industry_spot_em(self, symbol):
        assert symbol == "BK0896"
        return FakeFrame([
            {"item": "最新", "value": 1234.5},
            {"item": "涨跌幅", "value": 1.8},
            {"item": "成交额", "value": 30_000_000_000},
        ])

    def stock_board_industry_hist_em(self, **kwargs):
        assert kwargs["symbol"] == "白酒"
        return FakeFrame([
            {"日期": date(2026, 1, 1) + timedelta(days=index), "收盘": 1000 + index}
            for index in range(70)
        ])

    def stock_board_industry_cons_em(self, symbol):
        assert symbol == "BK0896"
        return FakeFrame([
            {"代码": "600519", "名称": "贵州茅台", "最新价": 1500, "涨跌幅": 2.1},
            {"代码": "000858", "名称": "五粮液", "最新价": 120, "涨跌幅": -0.5},
        ])

    def stock_zh_index_spot_em(self, symbol):
        assert symbol == "沪深重要指数"
        return FakeFrame([{"代码": "000300", "名称": "沪深300", "最新价": 4200, "涨跌幅": 0.8}])

    def stock_zh_index_daily_em(self, **kwargs):
        assert kwargs["symbol"] == "sh000300"
        return FakeFrame([
            {"date": date(2026, 1, 1) + timedelta(days=index), "close": 4000 + index}
            for index in range(70)
        ])


class FakeAkshareWithThsFallback(FakeAkshare):
    def stock_board_industry_name_em(self):
        raise RuntimeError("Eastmoney unavailable")

    def stock_board_industry_name_ths(self):
        return FakeFrame([{"code": "881273", "name": "白酒"}])


class FakeAkshareWithNameTable(FakeAkshare):
    def stock_info_a_code_name(self):
        return FakeFrame([
            {"code": "600519", "name": "贵州茅台"},
            {"code": "000858", "name": "五粮液"},
        ])

    def stock_zh_a_spot_em(self):
        raise RuntimeError("spot unavailable")


@pytest.mark.asyncio
async def test_akshare_maps_research_data_and_shares_spot_request():
    fake = FakeAkshare()
    provider = AkshareProvider(timeout=1, ak_module=fake)
    try:
        search, snapshot = await asyncio.gather(
            provider.search("贵州茅台"),
            provider.snapshot("SH.600519"),
        )
        bars, profile, financial = await asyncio.gather(
            provider.daily_bars("SH.600519", 60),
            provider.company_profile("SH.600519"),
            provider.financial_snapshot("SH.600519"),
        )
    finally:
        await provider.close()

    assert fake.spot_calls == 1
    assert search[0]["code"] == "SH.600519"
    assert snapshot["price"] == 1500
    assert snapshot["marketCap"] == 1_880_000_000_000
    assert len(bars) == 60
    assert bars[-1]["close"] == 1470
    assert profile == {
        "industry": "白酒",
        "listingDate": "2001-08-27",
        "totalShares": 1_256_197_800,
        "floatShares": 1_256_197_800,
        "floatMarketCap": None,
    }
    assert financial["reportDate"] == "2026-03-31"
    assert financial["revenueYoY"] == 8.1
    assert financial["roe"] == 12.5


@pytest.mark.asyncio
async def test_akshare_maps_beijing_exchange_code():
    provider = AkshareProvider(timeout=1, ak_module=FakeAkshare())
    try:
        rows = await provider.search("艾融软件")
    finally:
        await provider.close()
    assert rows[0]["code"] == "BJ.830799"


@pytest.mark.asyncio
async def test_akshare_name_search_does_not_require_spot_table():
    provider = AkshareProvider(timeout=1, ak_module=FakeAkshareWithNameTable())
    try:
        rows = await provider.search("茅台")
    finally:
        await provider.close()

    assert rows == [{"code": "SH.600519", "name": "贵州茅台", "market": "沪市"}]


@pytest.mark.asyncio
async def test_akshare_maps_sector_index_and_market_overview():
    provider = AkshareProvider(timeout=1, ak_module=FakeAkshare())
    try:
        catalog = await provider.sector_catalog("industry")
        snapshot = await provider.sector_snapshot("industry", "BK0896", "白酒")
        bars = await provider.sector_bars("industry", "白酒", 60)
        constituents = await provider.sector_constituents("industry", "BK0896", "白酒")
        index_snapshot = await provider.index_snapshot("sh000300", "沪深重要指数")
        index_bars = await provider.index_bars("sh000300", 60)
        overview = await provider.market_overview()
    finally:
        await provider.close()

    assert catalog == [{"kind": "industry", "code": "BK0896", "name": "白酒"}]
    assert snapshot["changePercent"] == 1.8
    assert len(bars) == 60
    assert constituents[0]["code"] == "SH.600519"
    assert index_snapshot["price"] == 4200
    assert len(index_bars) == 60
    assert overview["advancers"] == 1
    assert overview["decliners"] == 0


@pytest.mark.asyncio
async def test_akshare_sector_catalog_falls_back_to_ths():
    provider = AkshareProvider(timeout=1, ak_module=FakeAkshareWithThsFallback())
    try:
        catalog = await provider.sector_catalog("industry")
    finally:
        await provider.close()

    assert catalog == [{"kind": "industry_ths", "code": "881273", "name": "白酒"}]
