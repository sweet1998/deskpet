#!/usr/bin/env python3
"""Read-only local bridge between the deskpet and Futu OpenD."""

import argparse
import asyncio
from datetime import datetime, time as clock_time
import re
import socket
import time
from typing import Any, Dict, List, Optional, Tuple

from aiohttp import web

try:
    import futu
except ImportError:
    futu = None


CODE_PATTERN = re.compile(r"(?<!\d)(\d{6})(?!\d)")
MAX_SECURITIES = 3
NAME_CACHE_SECONDS = 24 * 60 * 60
KLINE_CACHE_SECONDS = 60
QUOTE_CACHE_SECONDS = 3


def map_a_share_code(code: str) -> Optional[str]:
    if not re.fullmatch(r"\d{6}", code):
        return None
    if code.startswith(("60", "68", "90")):
        return f"SH.{code}"
    if code.startswith(("00", "30", "20")):
        return f"SZ.{code}"
    if code.startswith(("43", "83", "87", "88", "92")):
        return f"BJ.{code}"
    return None


def scalar(value: Any) -> Any:
    if value is None:
        return None
    try:
        if value != value:
            return None
    except Exception:
        pass
    if hasattr(value, "item"):
        value = value.item()
    return value


class MarketService:
    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.quote_ctx = None
        self.name_cache: Tuple[float, List[Dict[str, str]]] = (0, [])
        self.quote_cache: Dict[str, Tuple[float, Dict[str, Any]]] = {}
        self.kline_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}

    def connect(self):
        if futu is None:
            raise RuntimeError("缺少 futu-api，请运行：pip install futu-api aiohttp")
        if self.quote_ctx is None:
            try:
                with socket.create_connection((self.host, self.port), timeout=1):
                    pass
            except OSError as error:
                raise RuntimeError(f"无法连接富途 OpenD {self.host}:{self.port}，请确认 OpenD 已启动并登录") from error
            self.quote_ctx = futu.OpenQuoteContext(host=self.host, port=self.port)
        return self.quote_ctx

    def close(self):
        if self.quote_ctx is not None:
            self.quote_ctx.close()
            self.quote_ctx = None

    def health_sync(self) -> Dict[str, Any]:
        if futu is None:
            return {"ok": False, "status": "dependency-missing", "message": "缺少 futu-api，请运行：pip install futu-api aiohttp"}
        try:
            ctx = self.connect()
            ret, data = ctx.get_global_state()
            if ret != futu.RET_OK:
                return {"ok": False, "status": "opend-unavailable", "message": str(data)}
            return {"ok": True, "status": "ready", "message": "富途 OpenD 行情连接正常"}
        except Exception as error:
            self.close()
            return {"ok": False, "status": "opend-unavailable", "message": str(error)}

    def basic_info_sync(self) -> List[Dict[str, str]]:
        now = time.time()
        if now - self.name_cache[0] < NAME_CACHE_SECONDS:
            return self.name_cache[1]
        ctx = self.connect()
        rows: List[Dict[str, str]] = []
        for market, prefix in ((futu.Market.SH, "SH"), (futu.Market.SZ, "SZ"), (getattr(futu.Market, "BJ", None), "BJ")):
            if market is None:
                continue
            ret, data = ctx.get_stock_basicinfo(market, futu.SecurityType.STOCK)
            if ret != futu.RET_OK:
                continue
            for _, row in data.iterrows():
                code = str(row.get("code", ""))
                name = str(row.get("name", ""))
                if code and name:
                    rows.append({"code": code, "name": name, "market": prefix})
        self.name_cache = (now, rows)
        return rows

    def resolve_sync(self, query: str) -> Tuple[List[Dict[str, str]], List[Dict[str, str]]]:
        found: List[Dict[str, str]] = []
        for raw_code in CODE_PATTERN.findall(query):
            code = map_a_share_code(raw_code)
            if code and not any(item["code"] == code for item in found):
                found.append({"code": code, "name": raw_code, "market": code[:2]})
        basics = self.basic_info_sync()
        by_code = {item["code"]: item for item in basics}
        found = [by_code.get(item["code"], item) for item in found]
        if found:
            return found[:MAX_SECURITIES], []

        exact = [item for item in basics if item["name"] and item["name"] in query]
        if len(exact) == 1:
            return exact, []
        if len(exact) > 1:
            longest = max(len(item["name"]) for item in exact)
            candidates = [item for item in exact if len(item["name"]) == longest]
            if len(candidates) == 1:
                return candidates, []
            return [], candidates[:10]

        tokens = [token for token in re.findall(r"[\u4e00-\u9fffA-Za-z]{2,12}", query) if len(token) >= 2]
        fuzzy = [item for item in basics if any(token in item["name"] or item["name"] in token for token in tokens)]
        unique = {item["code"]: item for item in fuzzy}
        if len(unique) == 1:
            return list(unique.values()), []
        if len(unique) > 1:
            return [], list(unique.values())[:10]
        return [], []

    def quote_sync(self, code: str) -> Dict[str, Any]:
        cached = self.quote_cache.get(code)
        if cached and time.time() - cached[0] < QUOTE_CACHE_SECONDS:
            return cached[1]
        ctx = self.connect()
        ret, data = ctx.get_market_snapshot([code])
        if ret != futu.RET_OK or data.empty:
            raise RuntimeError(str(data))
        row = data.iloc[0]
        data_time = str(row.get("update_time") or row.get("data_date") or "")
        now = datetime.now()
        trading = now.weekday() < 5 and (clock_time(9, 30) <= now.time() <= clock_time(11, 30) or clock_time(13, 0) <= now.time() <= clock_time(15, 0))
        age = 0.0
        try:
            age = (now - datetime.fromisoformat(data_time)).total_seconds()
        except Exception:
            pass
        result = {
            "code": code,
            "name": str(row.get("name") or code),
            "market": code[:2],
            "price": scalar(row.get("last_price")),
            "changePercent": scalar(row.get("change_rate")),
            "dataTime": data_time,
            "marketStatus": "trading" if trading else "closed",
            "stale": bool(trading and age > 60),
            "peRatio": scalar(row.get("pe_ratio")),
            "pbRatio": scalar(row.get("pb_ratio")),
            "marketCap": scalar(row.get("total_market_val")),
        }
        self.quote_cache[code] = (time.time(), result)
        return result

    def kline_sync(self, code: str) -> List[Dict[str, Any]]:
        cached = self.kline_cache.get(code)
        if cached and time.time() - cached[0] < KLINE_CACHE_SECONDS:
            return cached[1]
        ctx = self.connect()
        ret, data, _ = ctx.request_history_kline(code, ktype=futu.KLType.K_DAY, max_count=120)
        if ret != futu.RET_OK:
            raise RuntimeError(str(data))
        bars = [{
            "time": str(row.get("time_key", "")),
            "open": scalar(row.get("open")),
            "high": scalar(row.get("high")),
            "low": scalar(row.get("low")),
            "close": scalar(row.get("close")),
            "volume": scalar(row.get("volume")),
        } for _, row in data.tail(120).iterrows()]
        self.kline_cache[code] = (time.time(), bars)
        return bars

    def context_sync(self, query: str) -> Dict[str, Any]:
        securities, candidates = self.resolve_sync(query)
        if candidates:
            return {"status": "ambiguous", "source": "futu-opend", "candidates": candidates}
        if not securities:
            return {"status": "no-symbol", "source": "futu-opend"}
        output = []
        for security in securities[:MAX_SECURITIES]:
            quote = self.quote_sync(security["code"])
            quote["dailyBars"] = self.kline_sync(security["code"])
            output.append(quote)
        return {
            "status": "ok",
            "source": "futu-opend",
            "asOf": datetime.now().astimezone().isoformat(),
            "marketStatus": "trading" if any(item["marketStatus"] == "trading" for item in output) else "closed",
            "securities": output,
        }


async def create_app(args):
    service = MarketService(args.opend_host, args.opend_port)
    app = web.Application(client_max_size=64 * 1024)

    async def health(_request):
        return web.json_response(await asyncio.to_thread(service.health_sync))

    async def context(request):
        try:
            body = await request.json()
            query = str(body.get("query", "")).strip()[:4000]
            result = await asyncio.to_thread(service.context_sync, query)
            return web.json_response(result)
        except Exception as error:
            return web.json_response({"status": "unavailable", "source": "futu-opend", "error": str(error)}, status=503)

    app.router.add_get("/health", health)
    app.router.add_post("/context", context)
    app.on_cleanup.append(lambda _app: asyncio.to_thread(service.close))
    return app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen-host", default="127.0.0.1")
    parser.add_argument("--listen-port", type=int, default=18531)
    parser.add_argument("--opend-host", default="127.0.0.1")
    parser.add_argument("--opend-port", type=int, default=11111)
    args = parser.parse_args()
    web.run_app(create_app(args), host=args.listen_host, port=args.listen_port, print=None)


if __name__ == "__main__":
    main()
