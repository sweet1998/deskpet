from datetime import datetime
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import httpx

from .eastmoney import EastmoneyProvider, _market_name, _number


def tencent_symbol(code: str) -> str:
    market, symbol = code.split(".", 1)
    return f"{market.lower()}{symbol}"


def _field(values: List[str], index: int) -> str:
    return values[index] if index < len(values) else ""


class TencentProvider(EastmoneyProvider):
    """Tencent quotes/K-lines with Eastmoney name search."""

    name = "tencent-public"
    QUOTE_URL = "https://qt.gtimg.cn/q="
    KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
    MARKET_INDEXES = (
        ("sh000001", "上证指数"),
        ("sz399001", "深证成指"),
        ("sz399006", "创业板指"),
        ("sh000300", "沪深300"),
    )

    async def snapshot(self, code: str) -> Dict[str, Any]:
        symbol = tencent_symbol(code)
        response = await self.client.get(f"{self.QUOTE_URL}{symbol}")
        response.raise_for_status()
        text = response.content.decode("gbk", errors="replace")
        if '="' not in text:
            raise RuntimeError(f"腾讯行情没有返回 {code} 的快照")
        values = text.split('="', 1)[1].rsplit('"', 1)[0].split("~")
        raw_time = _field(values, 30)
        try:
            data_time = datetime.strptime(raw_time, "%Y%m%d%H%M%S").replace(
                tzinfo=ZoneInfo("Asia/Shanghai"),
            ).isoformat()
        except ValueError:
            data_time = datetime.now().astimezone().isoformat()
        market_cap = _number(_field(values, 44))
        return {
            "code": code,
            "name": _field(values, 1) or code,
            "market": _market_name(code),
            "price": _number(_field(values, 3)),
            "changePercent": _number(_field(values, 32)),
            "dataTime": data_time,
            "peRatio": _number(_field(values, 52)) or _number(_field(values, 39)),
            "pbRatio": _number(_field(values, 46)),
            "marketCap": market_cap * 100_000_000 if market_cap is not None else None,
        }

    async def daily_bars(self, code: str, count: int) -> List[Dict[str, Any]]:
        symbol = tencent_symbol(code)
        response = await self.client.get(self.KLINE_URL, params={
            "param": f"{symbol},day,,,{min(120, max(1, count))},qfq",
        })
        response.raise_for_status()
        data = response.json().get("data", {}).get(symbol, {})
        rows = data.get("qfqday") or data.get("day") or []
        output = []
        for parts in rows[-count:]:
            if not isinstance(parts, list) or len(parts) < 6:
                continue
            output.append({
                "time": str(parts[0]),
                "open": _number(parts[1]),
                "close": _number(parts[2]),
                "high": _number(parts[3]),
                "low": _number(parts[4]),
                "volume": _number(parts[5]),
            })
        return output

    async def index_snapshot(self, code: str, category: str) -> Dict[str, Any]:
        response = await self.client.get(f"{self.QUOTE_URL}{code}")
        response.raise_for_status()
        text = response.content.decode("gbk", errors="replace")
        if '="' not in text:
            raise RuntimeError(f"腾讯行情没有返回指数 {code}")
        values = text.split('="', 1)[1].rsplit('"', 1)[0].split("~")
        raw_time = _field(values, 30)
        try:
            data_time = datetime.strptime(raw_time, "%Y%m%d%H%M%S").replace(
                tzinfo=ZoneInfo("Asia/Shanghai"),
            ).isoformat()
        except ValueError:
            data_time = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        return {
            "code": code,
            "name": _field(values, 1) or code,
            "price": _number(_field(values, 3)),
            "changePercent": _number(_field(values, 32)),
            "change": _number(_field(values, 31)),
            "open": _number(_field(values, 5)),
            "high": _number(_field(values, 33)),
            "low": _number(_field(values, 34)),
            "volume": _number(_field(values, 6)),
            "amount": _number(_field(values, 37)),
            "dataTime": data_time,
        }

    async def index_bars(self, symbol: str, count: int) -> List[Dict[str, Any]]:
        response = await self.client.get(self.KLINE_URL, params={
            "param": f"{symbol},day,,,{min(120, max(1, count))},qfq",
        })
        response.raise_for_status()
        data = response.json().get("data", {}).get(symbol, {})
        rows = data.get("qfqday") or data.get("day") or []
        return [
            {
                "time": str(parts[0]),
                "open": _number(parts[1]),
                "close": _number(parts[2]),
                "high": _number(parts[3]),
                "low": _number(parts[4]),
                "volume": _number(parts[5]),
            }
            for parts in rows[-count:]
            if isinstance(parts, list) and len(parts) >= 6
        ]

    async def market_overview(self) -> Dict[str, Any]:
        symbols = ",".join(symbol for symbol, _ in self.MARKET_INDEXES)
        response = await self.client.get(f"{self.QUOTE_URL}{symbols}")
        response.raise_for_status()
        text = response.content.decode("gbk", errors="replace")
        names = {symbol[-6:]: name for symbol, name in self.MARKET_INDEXES}
        indexes = []
        for line in text.splitlines():
            if '="' not in line:
                continue
            values = line.split('="', 1)[1].rsplit('"', 1)[0].split("~")
            code = _field(values, 2)
            if code not in names:
                continue
            indexes.append({
                "code": code,
                "name": _field(values, 1) or names[code],
                "price": _number(_field(values, 3)),
                "change": _number(_field(values, 31)),
                "changePercent": _number(_field(values, 32)),
                "open": _number(_field(values, 5)),
                "high": _number(_field(values, 33)),
                "low": _number(_field(values, 34)),
                "dataTime": _field(values, 30),
            })
        if not indexes:
            raise RuntimeError("腾讯行情没有返回主要指数快照")
        return {
            "asOf": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            "indices": indexes,
        }
