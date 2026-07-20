import httpx
import pytest

from app.market.providers.tencent import TencentProvider


@pytest.mark.asyncio
async def test_tencent_market_overview_maps_major_indexes():
    rows = [
        "v_sh000001=\"1~上证指数~000001~3796.28~3764.15~3791.66~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260720150000~32.13~0.85~3831.66~3741.11\";",
        "v_sz399001=\"51~深证成指~399001~13610.23~13706.88~13869.06~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260720150000~-96.65~-0.71~13972.99~13342.93\";",
    ]

    async def handler(_request):
        return httpx.Response(200, content="\n".join(rows).encode("gbk"))

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    provider = TencentProvider(client=client)
    try:
        result = await provider.market_overview()
    finally:
        await client.aclose()

    assert [item["name"] for item in result["indices"]] == ["上证指数", "深证成指"]
    assert result["indices"][0]["price"] == 3796.28
    assert result["indices"][0]["changePercent"] == 0.85
    assert result["indices"][1]["changePercent"] == -0.71
