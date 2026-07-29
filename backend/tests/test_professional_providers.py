import json

import httpx
import pytest

from app.market.providers.cninfo import CninfoProvider
from app.market.providers.tushare import TushareProvider


def _tushare_response(fields, items):
    return httpx.Response(200, json={
        "code": 0,
        "msg": "",
        "data": {"fields": fields.split(","), "items": items},
    })


@pytest.mark.asyncio
async def test_tushare_daily_bars_are_qfq_adjusted_and_sorted():
    def handler(request):
        body = json.loads(request.content)
        if body["api_name"] == "daily":
            return _tushare_response(
                body["fields"],
                [
                    ["600519.SH", "20260729", 109, 112, 108, 110, 50, 120, 20, 200],
                    ["600519.SH", "20260728", 98, 102, 97, 100, 99, 1, 10, 100],
                ],
            )
        raise AssertionError(body["api_name"])

    client = httpx.AsyncClient(
        base_url="https://api.tushare.pro",
        transport=httpx.MockTransport(handler),
    )
    provider = TushareProvider("secret", client=client)
    try:
        bars = await provider.daily_bars("SH.600519", 2)
    finally:
        await client.aclose()

    assert [item["time"] for item in bars] == ["2026-07-28", "2026-07-29"]
    assert bars[0]["close"] == 50
    assert bars[1]["close"] == 110


@pytest.mark.asyncio
async def test_tushare_financial_history_preserves_period_and_announcement_time():
    def handler(request):
        body = json.loads(request.content)
        if body["api_name"] == "fina_indicator":
            return _tushare_response(body["fields"], [[
                "600519.SH", "20260430", "20260331", 20, 30, 29, 90, 50, 20, 10, 12, 8,
            ]])
        if body["api_name"] == "income":
            return _tushare_response(body["fields"], [[
                "600519.SH", "20260430", "20260430", "20260331", 1000, 1000, 500,
            ]])
        raise AssertionError(body["api_name"])

    client = httpx.AsyncClient(
        base_url="https://api.tushare.pro",
        transport=httpx.MockTransport(handler),
    )
    provider = TushareProvider("secret", client=client, financial_enabled=True)
    try:
        rows = await provider.financial_history("SH.600519")
    finally:
        await client.aclose()

    assert rows[0]["reportDate"] == "2026-03-31"
    assert rows[0]["announcedAt"] == "2026-04-30"
    assert rows[0]["revenue"] == 1000
    assert rows[0]["sourceRecordId"] == "tushare:600519.SH:20260331"


@pytest.mark.asyncio
async def test_tushare_profile_survives_daily_basic_rate_limit():
    def handler(request):
        body = json.loads(request.content)
        if body["api_name"] == "stock_basic":
            return _tushare_response(body["fields"], [[
                "600519.SH", "600519", "贵州茅台", "贵州", "白酒", "主板", "20010827", "L",
            ]])
        if body["api_name"] == "daily_basic":
            return httpx.Response(200, json={
                "code": 40203,
                "msg": "访问频率超限",
                "data": None,
            })
        raise AssertionError(body["api_name"])

    client = httpx.AsyncClient(
        base_url="https://api.tushare.pro",
        transport=httpx.MockTransport(handler),
    )
    provider = TushareProvider("secret", client=client)
    try:
        profile = await provider.company_profile("SH.600519")
    finally:
        await client.aclose()

    assert profile["industry"] == "白酒"
    assert profile["listingDate"] == "2001-08-27"
    assert profile["floatMarketCap"] is None


@pytest.mark.asyncio
async def test_cninfo_announcements_are_official_and_link_to_original_pdf():
    def handler(request):
        if request.method == "GET":
            return httpx.Response(200, json={"stockList": [{
                "code": "600519", "orgId": "gssh0600519", "zwjc": "贵州茅台",
            }]})
        return httpx.Response(200, json={"announcements": [{
            "secCode": "600519",
            "announcementId": "1225431263",
            "announcementTitle": "<em>贵州茅台</em>重大事项公告",
            "announcementTime": 1784304000000,
            "adjunctUrl": "finalpage/2026-07-18/1225431263.PDF",
        }]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = CninfoProvider(client=client)
    try:
        rows = await provider.company_announcements("SH.600519", 30, 10)
    finally:
        await client.aclose()

    assert rows[0]["sourceId"] == "cninfo:1225431263"
    assert rows[0]["title"] == "贵州茅台重大事项公告"
    assert rows[0]["verificationStatus"] == "official"
    assert rows[0]["url"] == "https://static.cninfo.com.cn/finalpage/2026-07-18/1225431263.PDF"
