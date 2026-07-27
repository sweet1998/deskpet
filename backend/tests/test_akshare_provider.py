import asyncio
from datetime import date, timedelta

import pytest

from app.market.providers.akshare_provider import AkshareProvider, _ths_sector_constituent_rows


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
        return FakeFrame([{
            "板块代码": "BK0896", "板块名称": "白酒", "最新价": 1234.5,
            "涨跌幅": 1.8, "总市值": 1_000_000_000_000, "换手率": 2.5,
            "上涨家数": 18, "下跌家数": 2, "领涨股票": "贵州茅台",
            "领涨股票-涨跌幅": 2.1,
        }])

    def stock_sector_fund_flow_rank(self, **kwargs):
        assert kwargs["sector_type"] == "行业资金流"
        values = {
            "今日": {"今日主力净流入-净额": 12},
            "5日": {"5日涨跌幅": 3.5, "5日主力净流入-净额": 30},
            "10日": {"10日涨跌幅": 6.8, "10日主力净流入-净额": 50},
        }
        return FakeFrame([{"名称": "白酒", **values[kwargs["indicator"]]}])

    def stock_board_industry_name_ths(self):
        return FakeFrame([
            {"code": "881273", "name": "白酒"},
            {"code": "881121", "name": "半导体"},
        ])

    def stock_board_industry_summary_ths(self):
        return FakeFrame([
            {
                "板块": "白酒", "涨跌幅": 1.8, "总成交额": 300, "净流入": 12,
                "上涨家数": 18, "下跌家数": 2, "均价": 80,
                "领涨股": "贵州茅台", "领涨股-最新价": 1500, "领涨股-涨跌幅": 2.1,
            },
            {
                "板块": "半导体", "涨跌幅": 2.5, "总成交额": 500, "净流入": 20,
                "上涨家数": 40, "下跌家数": 10, "均价": 35,
                "领涨股": "中芯国际", "领涨股-最新价": 100, "领涨股-涨跌幅": 5.2,
            },
        ])

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

    def stock_board_concept_info_ths(self, symbol):
        assert symbol == "创新药"
        return FakeFrame([
            {"项目": "今开", "值": "1219.28"},
            {"项目": "昨收", "值": "1229.17"},
            {"项目": "板块涨幅", "值": "-3.97%"},
            {"项目": "涨跌家数", "值": "6/273"},
            {"项目": "资金净流入(亿)", "值": "-88.67"},
            {"项目": "成交额(亿)", "值": "827.02"},
        ])

    def stock_board_concept_cons_ths(self, symbol):
        assert symbol == "创新药"
        return FakeFrame([
            {
                "代码": "600538", "名称": "国发股份", "现价": "4.77",
                "涨跌幅(%)": "6.95", "换手(%)": "4.03", "成交额": "0.98亿",
                "市盈率": "--",
            },
            {
                "代码": "300639", "名称": "凯普生物", "现价": "5.35",
                "涨跌幅(%)": "4.49", "换手(%)": "5.93", "成交额": "2.04亿",
                "市盈率": "35.2",
            },
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

    def tool_trade_date_hist_sina(self):
        self.calendar_calls = getattr(self, "calendar_calls", 0) + 1
        return FakeFrame([
            {"trade_date": "2026-07-24"},
            {"trade_date": date(2026, 7, 27)},
            {"trade_date": "2026-07-24"},
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
        scan_snapshot = await provider.sector_scan_snapshot("industry")
        snapshot = await provider.sector_snapshot("industry", "BK0896", "白酒")
        bars = await provider.sector_bars("industry", "白酒", 60)
        constituents = await provider.sector_constituents("industry", "BK0896", "白酒")
        index_snapshot = await provider.index_snapshot("sh000300", "沪深重要指数")
        index_bars = await provider.index_bars("sh000300", 60)
        overview = await provider.market_overview()
    finally:
        await provider.close()

    assert catalog == [{"kind": "industry", "code": "BK0896", "name": "白酒"}]
    assert scan_snapshot[0]["code"] == "BK0896"
    assert scan_snapshot[0]["netInflow"] == 12
    assert scan_snapshot[0]["change5d"] == 3.5
    assert scan_snapshot[0]["change10d"] == 6.8
    assert scan_snapshot[0]["source"] == "akshare-eastmoney"
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
        scan_snapshot = await provider.sector_scan_snapshot("industry")
    finally:
        await provider.close()

    assert catalog == [{"kind": "industry_ths", "code": "881273", "name": "白酒"}]
    assert scan_snapshot[0]["kind"] == "industry_ths"
    assert scan_snapshot[0]["source"] == "akshare-ths"


@pytest.mark.asyncio
async def test_akshare_maps_ths_concept_snapshot_and_constituents():
    provider = AkshareProvider(timeout=1, ak_module=FakeAkshare())
    try:
        snapshot = await provider.sector_snapshot("concept_ths", "308014", "创新药")
        constituents = await provider.sector_constituents("concept_ths", "308014", "创新药")
    finally:
        await provider.close()

    assert snapshot["changePercent"] == -3.97
    assert snapshot["advancers"] == 6
    assert snapshot["decliners"] == 273
    assert snapshot["amount"] == 82_702_000_000
    assert constituents[0]["code"] == "SH.600538"
    assert constituents[0]["changePercent"] == 6.95
    assert constituents[0]["amount"] == 98_000_000
    assert constituents[1]["code"] == "SZ.300639"


@pytest.mark.asyncio
async def test_akshare_trade_calendar_dedupes_normalizes_and_caches():
    fake = FakeAkshare()
    provider = AkshareProvider(timeout=1, ak_module=fake)
    try:
        first = await provider.trade_calendar()
        second = await provider.trade_calendar()
    finally:
        await provider.close()

    assert first == ["2026-07-24", "2026-07-27"]
    assert second == first
    assert fake.calendar_calls == 1


def test_ths_constituent_parser_uses_structured_table(monkeypatch):
    html = """
    <table class="m-table m-pager-table">
      <thead><tr><th>代码</th><th>名称</th><th>现价</th></tr></thead>
      <tbody><tr><td>600538</td><td>国发股份</td><td>4.77</td></tr></tbody>
    </table>
    """

    class Response:
        text = html

        @staticmethod
        def raise_for_status():
            return None

    monkeypatch.setattr(
        "app.market.providers.akshare_provider.requests.get",
        lambda *args, **kwargs: Response(),
    )
    assert _ths_sector_constituent_rows("concept_ths", "308014", 1) == [{
        "代码": "600538", "名称": "国发股份", "现价": "4.77",
    }]
