from datetime import datetime

import pytest

from app.market.providers.sina import SinaProvider


class FakeFrame:
    empty = False

    def to_dict(self, orient):
        assert orient == "records"
        return [{
            "代码": "sh600519",
            "名称": "贵州茅台",
            "最新价": 1500,
            "涨跌幅": 1.2,
            "成交额": 8_000_000_000,
            "时间戳": "15:00:00",
        }, {
            "代码": "bj920000",
            "名称": "安徽凤凰",
            "最新价": 12.8,
            "涨跌幅": -6.1,
            "成交额": 38_000_000,
            "时间戳": "15:30:00",
        }]


class FakeSinaAkshare:
    def stock_zh_a_spot(self):
        return FakeFrame()


@pytest.mark.asyncio
async def test_sina_maps_full_market_rows_without_inventing_valuation_fields():
    provider = SinaProvider(timeout=1, ak_module=FakeSinaAkshare())
    try:
        rows = await provider.stock_universe_snapshot()
    finally:
        await provider.close()

    assert rows[0]["code"] == "SH.600519"
    assert rows[0]["amount"] == 8_000_000_000
    assert rows[1]["code"] == "BJ.920000"
    assert "peRatio" not in rows[0]
    assert "marketCap" not in rows[0]
    assert datetime.fromisoformat(rows[0]["dataTime"]).tzinfo is not None
