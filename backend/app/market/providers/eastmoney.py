from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx

from .base import MarketProvider


def _number(value: Any, scale: float = 1.0) -> Optional[float]:
    if value in (None, "", "-"):
        return None
    try:
        return float(value) / scale
    except (TypeError, ValueError):
        return None


def _market_name(code: str) -> str:
    return {"SH": "沪市", "SZ": "深市", "BJ": "北交所"}.get(code[:2], code[:2])


def eastmoney_secid(code: str) -> str:
    market, symbol = code.split(".", 1)
    return f"{1 if market == 'SH' else 0}.{symbol}"


def normalize_eastmoney_code(value: str) -> Optional[str]:
    raw = value.strip().upper()
    if "." in raw:
        prefix, symbol = raw.split(".", 1)
        if prefix in ("SH", "SZ", "BJ") and symbol.isdigit() and len(symbol) == 6:
            return raw
        if prefix in ("0", "1") and symbol.isdigit() and len(symbol) == 6:
            return map_symbol(symbol)
    return map_symbol(raw)


def map_symbol(symbol: str) -> Optional[str]:
    if not symbol.isdigit() or len(symbol) != 6:
        return None
    if symbol.startswith(("60", "68", "90")):
        return f"SH.{symbol}"
    if symbol.startswith(("00", "20", "30")):
        return f"SZ.{symbol}"
    if symbol.startswith(("43", "83", "87", "88", "92")):
        return f"BJ.{symbol}"
    return None


class EastmoneyProvider(MarketProvider):
    name = "eastmoney-public"
    QUOTE_URL = "https://push2.eastmoney.com/api/qt/stock/get"
    KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
    SEARCH_URL = "https://searchapi.eastmoney.com/api/suggest/get"
    SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8"

    def __init__(self, timeout: float = 8.0, client: Optional[httpx.AsyncClient] = None):
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            timeout=timeout,
            headers={"User-Agent": "Mozilla/5.0 DeskpetMarket/1.0"},
        )

    async def search(self, query: str) -> List[Dict[str, str]]:
        response = await self.client.get(self.SEARCH_URL, params={
            "input": query,
            "type": "14",
            "count": "10",
            "token": self.SEARCH_TOKEN,
        }, headers={"Referer": "https://quote.eastmoney.com/"})
        response.raise_for_status()
        body = response.json()
        rows = (((body.get("QuotationCodeTable") or {}).get("Data")) or [])
        output = []
        for row in rows:
            code = normalize_eastmoney_code(str(row.get("Code") or row.get("SecurityCode") or ""))
            if not code:
                continue
            output.append({
                "code": code,
                "name": str(row.get("Name") or row.get("SecurityShortName") or code),
                "market": _market_name(code),
            })
        return output

    async def snapshot(self, code: str) -> Dict[str, Any]:
        fields = "f57,f58,f43,f116,f162,f167,f170,f124"
        response = await self.client.get(self.QUOTE_URL, params={
            "secid": eastmoney_secid(code),
            "fields": fields,
        })
        response.raise_for_status()
        data = response.json().get("data") or {}
        timestamp = data.get("f124")
        data_time = datetime.fromtimestamp(timestamp).astimezone().isoformat() if timestamp else datetime.now().astimezone().isoformat()
        return {
            "code": code,
            "name": str(data.get("f58") or code),
            "market": _market_name(code),
            "price": _number(data.get("f43"), 100),
            "changePercent": _number(data.get("f170"), 100),
            "dataTime": data_time,
            "peRatio": _number(data.get("f162"), 100),
            "pbRatio": _number(data.get("f167"), 100),
            "marketCap": _number(data.get("f116")),
        }

    async def daily_bars(self, code: str, count: int) -> List[Dict[str, Any]]:
        response = await self.client.get(self.KLINE_URL, params={
            "secid": eastmoney_secid(code),
            "klt": "101",
            "fqt": "1",
            "lmt": str(min(120, max(1, count))),
            "end": "20500101",
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        })
        response.raise_for_status()
        rows = ((response.json().get("data") or {}).get("klines")) or []
        output = []
        for value in rows[-count:]:
            parts = str(value).split(",")
            if len(parts) < 6:
                continue
            output.append({
                "time": parts[0],
                "open": _number(parts[1]),
                "close": _number(parts[2]),
                "high": _number(parts[3]),
                "low": _number(parts[4]),
                "volume": _number(parts[5]),
            })
        return output

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
