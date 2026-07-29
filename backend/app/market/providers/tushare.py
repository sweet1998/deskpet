import asyncio
from datetime import datetime, timedelta
import math
import time
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import httpx

from .base import MarketProvider


def _number(value: Any) -> Optional[float]:
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _date_text(value: Any) -> Optional[str]:
    digits = "".join(character for character in str(value or "") if character.isdigit())
    if len(digits) < 8:
        return None
    return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"


def _api_code(code: str) -> str:
    market, symbol = code.split(".", 1)
    return f"{symbol}.{market}"


def _market_code(ts_code: str) -> str:
    symbol, market = ts_code.split(".", 1)
    return f"{market}.{symbol}"


def _market_name(code: str) -> str:
    return {"SH": "沪市", "SZ": "深市", "BJ": "北交所"}.get(code[:2], code[:2])


class TushareProvider(MarketProvider):
    name = "tushare-pro"

    def __init__(
        self,
        token: str,
        timeout: float = 8.0,
        client: Optional[httpx.AsyncClient] = None,
        financial_enabled: bool = False,
    ):
        if not token.strip():
            raise ValueError("TUSHARE_TOKEN 未配置")
        self.token = token.strip()
        self.financial_enabled = financial_enabled
        self.capabilities = (
            "security_master",
            "adjusted_daily_kline_from_preclose",
            "daily_valuation",
            "trade_calendar",
            *(("financial_history",) if financial_enabled else ()),
        )
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            base_url="https://api.tushare.pro",
            timeout=timeout,
            headers={"Content-Type": "application/json"},
        )
        self._stock_rows: List[Dict[str, Any]] = []
        self._stock_expires_at = 0.0
        self._stock_lock = asyncio.Lock()

    async def _query(
        self,
        api_name: str,
        params: Dict[str, Any],
        fields: str,
    ) -> List[Dict[str, Any]]:
        response = await self.client.post("", json={
            "api_name": api_name,
            "token": self.token,
            "params": params,
            "fields": fields,
        })
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != 0:
            message = str(payload.get("msg") or f"错误码 {payload.get('code')}")
            raise RuntimeError(f"Tushare {api_name} 调用失败：{message[:240]}")
        data = payload.get("data") or {}
        names = data.get("fields") or []
        return [dict(zip(names, values)) for values in (data.get("items") or [])]

    async def _stock_basic(self) -> List[Dict[str, Any]]:
        now = time.monotonic()
        if self._stock_rows and now < self._stock_expires_at:
            return self._stock_rows
        async with self._stock_lock:
            now = time.monotonic()
            if self._stock_rows and now < self._stock_expires_at:
                return self._stock_rows
            rows = await self._query(
                "stock_basic",
                {"list_status": "L"},
                "ts_code,symbol,name,area,industry,market,list_date,list_status",
            )
            if not rows:
                raise RuntimeError("Tushare 没有返回上市证券主数据")
            self._stock_rows = rows
            self._stock_expires_at = time.monotonic() + 24 * 60 * 60
            return rows

    async def search(self, query: str) -> List[Dict[str, str]]:
        normalized = query.strip().casefold()
        matches = []
        for row in await self._stock_basic():
            symbol = str(row.get("symbol") or "")
            name = str(row.get("name") or "")
            if normalized not in {symbol.casefold(), name.casefold()} and normalized not in name.casefold():
                continue
            code = _market_code(str(row["ts_code"]))
            matches.append({"code": code, "name": name, "market": _market_name(code)})
        matches.sort(key=lambda item: (item["name"] != query, len(item["name"]), item["code"]))
        return matches[:10]

    async def instrument_master(self) -> List[Dict[str, Any]]:
        ingested_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        output = []
        for row in await self._stock_basic():
            ts_code = str(row.get("ts_code") or "")
            if "." not in ts_code:
                continue
            code = _market_code(ts_code)
            if code[:2] not in {"SH", "SZ", "BJ"}:
                continue
            output.append({
                "instrumentId": code,
                "symbol": str(row.get("symbol") or code.split(".", 1)[1]),
                "name": str(row.get("name") or ""),
                "industry": row.get("industry"),
                "market": _market_name(code),
                "listDate": _date_text(row.get("list_date")),
                "listStatus": row.get("list_status") or "L",
                "validFrom": _date_text(row.get("list_date")),
                "validTo": None,
                "source": self.name,
                "ingestedAt": ingested_at,
            })
        return output

    async def market_daily(self, trade_date: str) -> List[Dict[str, Any]]:
        compact_date = trade_date.replace("-", "")
        rows = await self._query(
            "daily",
            {"trade_date": compact_date},
            "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount",
        )
        ingested_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        output = []
        for row in rows:
            ts_code = str(row.get("ts_code") or "")
            if "." not in ts_code:
                continue
            code = _market_code(ts_code)
            output.append({
                "instrumentId": code,
                "tradeDate": _date_text(row.get("trade_date")) or trade_date,
                "open": _number(row.get("open")),
                "high": _number(row.get("high")),
                "low": _number(row.get("low")),
                "close": _number(row.get("close")),
                "preClose": _number(row.get("pre_close")),
                "pctChange": _number(row.get("pct_chg")),
                "volume": (_number(row.get("vol")) or 0) * 100 or None,
                "amount": (_number(row.get("amount")) or 0) * 1_000 or None,
                "source": self.name,
                "ingestedAt": ingested_at,
            })
        return output

    async def market_valuation(self, trade_date: str) -> List[Dict[str, Any]]:
        rows = await self._query(
            "daily_basic",
            {"trade_date": trade_date.replace("-", "")},
            "ts_code,trade_date,turnover_rate,pe_ttm,pb,total_mv,circ_mv",
        )
        ingested_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        output = []
        for row in rows:
            ts_code = str(row.get("ts_code") or "")
            if "." not in ts_code:
                continue
            output.append({
                "instrumentId": _market_code(ts_code),
                "tradeDate": _date_text(row.get("trade_date")) or trade_date,
                "turnoverRate": _number(row.get("turnover_rate")),
                "peTtm": _number(row.get("pe_ttm")),
                "pb": _number(row.get("pb")),
                "totalMarketCap": (_number(row.get("total_mv")) or 0) * 10_000 or None,
                "floatMarketCap": (_number(row.get("circ_mv")) or 0) * 10_000 or None,
                "source": self.name,
                "ingestedAt": ingested_at,
            })
        return output

    async def _daily_basic(self, code: str) -> Dict[str, Any]:
        end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        rows = await self._query(
            "daily_basic",
            {
                "ts_code": _api_code(code),
                "start_date": (end - timedelta(days=30)).strftime("%Y%m%d"),
                "end_date": end.strftime("%Y%m%d"),
            },
            "ts_code,trade_date,pe_ttm,pb,total_share,float_share,total_mv,circ_mv",
        )
        return max(rows, key=lambda item: str(item.get("trade_date") or "")) if rows else {}

    async def snapshot(self, code: str) -> Dict[str, Any]:
        end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        start = end - timedelta(days=30)
        daily_rows, basic = await asyncio.gather(
            self._query(
                "daily",
                {
                    "ts_code": _api_code(code),
                    "start_date": start.strftime("%Y%m%d"),
                    "end_date": end.strftime("%Y%m%d"),
                },
                "ts_code,trade_date,close,pct_chg,vol,amount",
            ),
            self._daily_basic(code),
        )
        if not daily_rows:
            raise RuntimeError(f"Tushare 没有返回 {code} 的最近日行情")
        row = max(daily_rows, key=lambda item: str(item.get("trade_date") or ""))
        stock = next((item for item in await self._stock_basic() if item.get("ts_code") == _api_code(code)), {})
        data_date = _date_text(row.get("trade_date"))
        data_time = f"{data_date}T15:00:00+08:00" if data_date else ""
        return {
            "code": code,
            "name": stock.get("name") or code.split(".", 1)[1],
            "market": _market_name(code),
            "price": _number(row.get("close")),
            "changePercent": _number(row.get("pct_chg")),
            "dataTime": data_time,
            "peRatio": _number(basic.get("pe_ttm")),
            "pbRatio": _number(basic.get("pb")),
            "marketCap": (_number(basic.get("total_mv")) or 0) * 10_000 or None,
            "floatMarketCap": (_number(basic.get("circ_mv")) or 0) * 10_000 or None,
        }

    async def daily_bars(self, code: str, count: int) -> List[Dict[str, Any]]:
        safe_count = max(1, min(120, count))
        end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        start = end - timedelta(days=max(240, safe_count * 3))
        params = {
            "ts_code": _api_code(code),
            "start_date": start.strftime("%Y%m%d"),
            "end_date": end.strftime("%Y%m%d"),
        }
        daily_rows = await self._query(
            "daily",
            params,
            "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount",
        )
        rows = sorted(daily_rows, key=lambda item: str(item.get("trade_date") or ""))[-safe_count:]
        scales = [1.0] * len(rows)
        for index in range(len(rows) - 1, 0, -1):
            previous_close = _number(rows[index - 1].get("close"))
            comparable_pre_close = _number(rows[index].get("pre_close"))
            if previous_close and comparable_pre_close:
                scales[index - 1] = scales[index] * comparable_pre_close / previous_close
        output = []
        for row, ratio in zip(rows, scales):
            output.append({
                "time": _date_text(row.get("trade_date")) or "",
                "open": (_number(row.get("open")) or 0) * ratio or None,
                "high": (_number(row.get("high")) or 0) * ratio or None,
                "low": (_number(row.get("low")) or 0) * ratio or None,
                "close": (_number(row.get("close")) or 0) * ratio or None,
                "volume": _number(row.get("vol")),
            })
        if not output:
            raise RuntimeError(f"Tushare 没有返回 {code} 的复权日线")
        return output

    async def company_profile(self, code: str) -> Dict[str, Any]:
        stock_rows = await self._stock_basic()
        try:
            basic = await self._daily_basic(code)
        except Exception:
            basic = {}
        stock = next((item for item in stock_rows if item.get("ts_code") == _api_code(code)), None)
        if not stock:
            raise RuntimeError(f"Tushare 没有返回 {code} 的证券主数据")
        return {
            "industry": stock.get("industry"),
            "listingDate": _date_text(stock.get("list_date")),
            "totalShares": (_number(basic.get("total_share")) or 0) * 10_000 or None,
            "floatShares": (_number(basic.get("float_share")) or 0) * 10_000 or None,
            "floatMarketCap": (_number(basic.get("circ_mv")) or 0) * 10_000 or None,
        }

    async def financial_history(self, code: str, limit: int = 12) -> List[Dict[str, Any]]:
        if not self.financial_enabled:
            raise RuntimeError("当前配置未启用 Tushare 财务接口")
        end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        params = {
            "ts_code": _api_code(code),
            "start_date": (end - timedelta(days=5 * 365)).strftime("%Y%m%d"),
            "end_date": end.strftime("%Y%m%d"),
        }
        indicators, income = await asyncio.gather(
            self._query(
                "fina_indicator",
                params,
                "ts_code,ann_date,end_date,eps,roe,roe_dt,grossprofit_margin,netprofit_margin,debt_to_assets,ocfps,or_yoy,netprofit_yoy",
            ),
            self._query(
                "income",
                params,
                "ts_code,ann_date,f_ann_date,end_date,revenue,total_revenue,n_income_attr_p",
            ),
        )
        income_by_period = {}
        for row in sorted(income, key=lambda item: str(item.get("ann_date") or "")):
            income_by_period[str(row.get("end_date") or "")] = row
        output_by_period = {}
        for row in sorted(indicators, key=lambda item: str(item.get("ann_date") or "")):
            period = str(row.get("end_date") or "")
            income_row = income_by_period.get(period, {})
            output_by_period[period] = {
                "reportDate": _date_text(period),
                "announcedAt": _date_text(row.get("ann_date") or income_row.get("ann_date")),
                "eps": _number(row.get("eps")),
                "revenue": _number(income_row.get("revenue") or income_row.get("total_revenue")),
                "revenueYoY": _number(row.get("or_yoy")),
                "netProfit": _number(income_row.get("n_income_attr_p")),
                "netProfitYoY": _number(row.get("netprofit_yoy")),
                "roe": _number(row.get("roe_dt") or row.get("roe")),
                "grossMargin": _number(row.get("grossprofit_margin")),
                "netMargin": _number(row.get("netprofit_margin")),
                "debtRatio": _number(row.get("debt_to_assets")),
                "operatingCashFlowPerShare": _number(row.get("ocfps")),
                "sourceRecordId": f"tushare:{_api_code(code)}:{period}",
            }
        return sorted(
            output_by_period.values(),
            key=lambda item: item.get("reportDate") or "",
            reverse=True,
        )[:max(1, min(20, limit))]

    async def financial_snapshot(self, code: str) -> Dict[str, Any]:
        rows = await self.financial_history(code, 1)
        if not rows:
            raise RuntimeError(f"Tushare 没有返回 {code} 的财务指标")
        return rows[0]

    async def trade_calendar(self) -> List[str]:
        today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        rows = await self._query(
            "trade_cal",
            {
                "exchange": "SSE",
                "start_date": (today - timedelta(days=370)).strftime("%Y%m%d"),
                "end_date": (today + timedelta(days=370)).strftime("%Y%m%d"),
                "is_open": "1",
            },
            "exchange,cal_date,is_open,pretrade_date",
        )
        dates = sorted(filter(None, (_date_text(item.get("cal_date")) for item in rows)))
        if not dates:
            raise RuntimeError("Tushare 没有返回交易日历")
        return dates

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
