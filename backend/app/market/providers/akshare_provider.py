import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from functools import partial
import hashlib
import math
import time
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

from .base import MarketProvider
from .eastmoney import _market_name, map_symbol


def _clean(value: Any) -> Any:
    if value is None:
        return None
    try:
        if value != value:
            return None
    except (TypeError, ValueError):
        return None
    text = str(value).strip()
    return None if text in ("", "-", "--", "None", "<NA>", "NaT") else value


def _number(value: Any) -> Optional[float]:
    value = _clean(value)
    if value is None:
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _display_number(value: Any, default_scale: float = 1.0) -> Optional[float]:
    raw = _text(value)
    if raw is None:
        return None
    normalized = raw.replace(",", "").replace("%", "").strip()
    scales = {"万手": 10_000, "亿": 100_000_000, "万": 10_000}
    for suffix, scale in scales.items():
        if normalized.endswith(suffix):
            number = _number(normalized[:-len(suffix)])
            return number * scale if number is not None else None
    number = _number(normalized)
    return number * default_scale if number is not None else None


def _breadth(value: Any) -> tuple[Optional[int], Optional[int]]:
    raw = _text(value)
    if not raw or "/" not in raw:
        return None, None
    advancers, decliners = raw.split("/", 1)
    try:
        return int(advancers.strip()), int(decliners.strip())
    except ValueError:
        return None, None


def _text(value: Any) -> Optional[str]:
    value = _clean(value)
    return str(value).strip() if value is not None else None


def _date_text(value: Any) -> Optional[str]:
    value = _clean(value)
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.date().isoformat() if isinstance(value, datetime) else value.isoformat()
    raw = str(value).strip().split(" ", 1)[0]
    digits = "".join(character for character in raw if character.isdigit())
    if len(digits) >= 8:
        return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
    return raw or None


def _records(frame: Any) -> List[Dict[str, Any]]:
    if frame is None:
        return []
    if isinstance(frame, list):
        return [dict(item) for item in frame if isinstance(item, dict)]
    if getattr(frame, "empty", False):
        return []
    return [dict(item) for item in frame.to_dict(orient="records")]


def _first_text(row: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = _text(row.get(key))
        if value:
            return value
    return ""


def _published_text(value: Any) -> str:
    cleaned = _clean(value)
    if isinstance(cleaned, datetime):
        return cleaned.isoformat()
    if isinstance(cleaned, date):
        return cleaned.isoformat()
    raw = str(cleaned or "").strip()
    if not raw:
        return ""
    try:
        return datetime.fromisoformat(raw.replace("/", "-")).isoformat()
    except ValueError:
        return _date_text(raw) or raw[:40]


EVENT_KEYWORDS = {
    "earnings": ("业绩", "财报", "营收", "利润", "预增", "预减", "快报"),
    "buyback": ("回购",),
    "shareholding": ("增持", "减持", "持股变动", "质押", "解禁"),
    "regulatory": ("问询", "监管", "处罚", "立案", "警示函"),
    "restructuring": ("并购", "重组", "收购", "重大资产"),
    "contract": ("中标", "合同", "订单", "签约"),
    "risk": ("风险提示", "诉讼", "仲裁", "退市", "停牌"),
    "policy": ("政策", "规划", "指导意见"),
}


def _event_types(title: str, summary: str = "") -> List[str]:
    material = f"{title} {summary}"
    values = [name for name, keywords in EVENT_KEYWORDS.items() if any(word in material for word in keywords)]
    return values or ["other"]


def _source_id(kind: str, title: str, published_at: str, url: str) -> str:
    digest = hashlib.sha1(f"{kind}|{title}|{published_at}|{url}".encode("utf-8")).hexdigest()[:16]
    return f"{kind}:{digest}"


def _ths_sector_constituent_rows(category: str, code: str, timeout: float) -> List[Dict[str, Any]]:
    path = "thshy" if category == "industry_ths" else "gn"
    response = requests.get(
        f"https://q.10jqka.com.cn/{path}/detail/code/{code}/",
        headers={"User-Agent": "Mozilla/5.0 DeskpetMarket/1.0"},
        timeout=timeout,
    )
    response.raise_for_status()
    soup = BeautifulSoup(response.text, features="lxml")
    table = soup.select_one("table.m-pager-table")
    if table is None:
        raise RuntimeError("同花顺板块页面没有返回成分股表格")
    headers = [item.get_text(" ", strip=True) for item in table.select("thead th")]
    if not headers:
        headers = [item.get_text(" ", strip=True) for item in table.select("tr th")]
    output = []
    for row in table.select("tbody tr"):
        values = [item.get_text(" ", strip=True) for item in row.select("td")]
        if headers and len(values) == len(headers):
            output.append(dict(zip(headers, values)))
    return output


class AkshareProvider(MarketProvider):
    name = "akshare-eastmoney"

    def __init__(
        self,
        timeout: float = 8.0,
        max_workers: int = 4,
        ak_module: Any = None,
    ):
        if ak_module is None:
            import akshare as ak_module
        self.ak = ak_module
        self.timeout = timeout
        self.executor = ThreadPoolExecutor(
            max_workers=max(1, max_workers),
            thread_name_prefix="deskpet-akshare",
        )
        self._spot_rows: List[Dict[str, Any]] = []
        self._spot_expires_at = 0.0
        self._spot_lock = asyncio.Lock()
        self._name_rows: List[Dict[str, Any]] = []
        self._name_expires_at = 0.0
        self._name_lock = asyncio.Lock()
        self._calendar_dates: List[str] = []
        self._calendar_expires_at = 0.0
        self._calendar_lock = asyncio.Lock()

    async def _call(self, function: Any, *args: Any, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(self.executor, partial(function, *args, **kwargs))
        try:
            return await asyncio.wait_for(future, timeout=self.timeout)
        except asyncio.TimeoutError as error:
            raise RuntimeError(f"AKShare 请求超过 {self.timeout:g} 秒") from error

    async def _spot_table(self) -> List[Dict[str, Any]]:
        now = time.monotonic()
        if self._spot_rows and now < self._spot_expires_at:
            return self._spot_rows
        async with self._spot_lock:
            now = time.monotonic()
            if self._spot_rows and now < self._spot_expires_at:
                return self._spot_rows
            rows = _records(await self._call(self.ak.stock_zh_a_spot_em))
            if not rows:
                raise RuntimeError("AKShare 没有返回 A 股实时行情")
            self._spot_rows = rows
            self._spot_expires_at = time.monotonic() + 15
            return rows

    async def _name_table(self) -> List[Dict[str, Any]]:
        now = time.monotonic()
        if self._name_rows and now < self._name_expires_at:
            return self._name_rows
        async with self._name_lock:
            now = time.monotonic()
            if self._name_rows and now < self._name_expires_at:
                return self._name_rows
            function = getattr(self.ak, "stock_info_a_code_name", None)
            if function is None:
                raise RuntimeError("当前 AKShare 版本没有 A 股代码名称接口")
            rows = _records(await self._call(function))
            if not rows:
                raise RuntimeError("AKShare 没有返回 A 股代码名称表")
            self._name_rows = rows
            self._name_expires_at = time.monotonic() + 86400
            return rows

    async def trade_calendar(self) -> List[str]:
        now = time.monotonic()
        if self._calendar_dates and now < self._calendar_expires_at:
            return self._calendar_dates
        async with self._calendar_lock:
            now = time.monotonic()
            if self._calendar_dates and now < self._calendar_expires_at:
                return self._calendar_dates
            function = getattr(self.ak, "tool_trade_date_hist_sina", None)
            if function is None:
                raise RuntimeError("当前 AKShare 版本没有交易日历接口")
            rows = _records(await self._call(function))
            dates = sorted({
                iso
                for iso in (_date_text(row.get("trade_date")) for row in rows)
                if iso
            })
            if not dates:
                raise RuntimeError("AKShare 没有返回交易日历")
            self._calendar_dates = dates
            self._calendar_expires_at = time.monotonic() + 6 * 60 * 60
            return dates

    async def search(self, query: str) -> List[Dict[str, str]]:
        normalized = query.strip().lower()
        for loader, code_key, name_key in (
            (self._name_table, "code", "name"),
            (self._spot_table, "代码", "名称"),
        ):
            try:
                rows = await loader()
            except Exception:
                continue
            output: List[Dict[str, str]] = []
            for row in rows:
                symbol = str(row.get(code_key) or "").strip()
                name = str(row.get(name_key) or "").strip()
                code = map_symbol(symbol)
                if not code or normalized not in name.lower():
                    continue
                output.append({"code": code, "name": name, "market": _market_name(code)})
                if len(output) >= 10:
                    break
            if output:
                return output
        return []

    async def snapshot(self, code: str) -> Dict[str, Any]:
        symbol = code.split(".", 1)[1]
        for row in await self._spot_table():
            if str(row.get("代码") or "").strip() != symbol:
                continue
            return {
                "code": code,
                "name": _text(row.get("名称")) or symbol,
                "market": _market_name(code),
                "price": _number(row.get("最新价")),
                "changePercent": _number(row.get("涨跌幅")),
                "dataTime": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
                "peRatio": _number(row.get("市盈率-动态")),
                "pbRatio": _number(row.get("市净率")),
                "marketCap": _number(row.get("总市值")),
                "floatMarketCap": _number(row.get("流通市值")),
            }
        raise RuntimeError(f"AKShare 实时行情中没有 {code}")

    async def daily_bars(self, code: str, count: int) -> List[Dict[str, Any]]:
        symbol = code.split(".", 1)[1]
        end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        start = end - timedelta(days=max(240, count * 3))
        frame = await self._call(
            self.ak.stock_zh_a_hist,
            symbol=symbol,
            period="daily",
            start_date=start.strftime("%Y%m%d"),
            end_date=end.strftime("%Y%m%d"),
            adjust="qfq",
        )
        output = []
        for row in _records(frame)[-count:]:
            output.append({
                "time": _date_text(row.get("日期")) or "",
                "open": _number(row.get("开盘")),
                "close": _number(row.get("收盘")),
                "high": _number(row.get("最高")),
                "low": _number(row.get("最低")),
                "volume": _number(row.get("成交量")),
            })
        if not output:
            raise RuntimeError(f"AKShare 没有返回 {code} 的日 K")
        return output

    async def company_profile(self, code: str) -> Dict[str, Any]:
        symbol = code.split(".", 1)[1]
        frame = await self._call(self.ak.stock_individual_info_em, symbol=symbol)
        values = {
            str(row.get("item") or "").strip(): row.get("value")
            for row in _records(frame)
        }
        if not values:
            raise RuntimeError(f"AKShare 没有返回 {code} 的公司资料")
        return {
            "industry": _text(values.get("行业")),
            "listingDate": _date_text(values.get("上市时间")),
            "totalShares": _number(values.get("总股本")),
            "floatShares": _number(values.get("流通股")),
            "floatMarketCap": _number(values.get("流通市值")),
        }

    async def financial_history(self, code: str, limit: int = 12) -> List[Dict[str, Any]]:
        market, symbol = code.split(".", 1)
        frame = await self._call(
            self.ak.stock_financial_analysis_indicator_em,
            symbol=f"{symbol}.{market}",
            indicator="按报告期",
        )
        rows = _records(frame)
        if not rows:
            raise RuntimeError(f"AKShare 没有返回 {code} 的财务指标")
        output_by_period = {}
        for row in rows:
            report_date = _date_text(row.get("REPORT_DATE"))
            if not report_date:
                continue
            output_by_period[report_date] = {
                "reportDate": report_date,
                "announcedAt": _date_text(row.get("NOTICE_DATE") or row.get("UPDATE_DATE")),
                "eps": _number(row.get("EPSJB")),
                "revenue": _number(row.get("TOTALOPERATEREVE")),
                "revenueYoY": _number(row.get("TOTALOPERATEREVETZ")),
                "netProfit": _number(row.get("PARENTNETPROFIT")),
                "netProfitYoY": _number(row.get("PARENTNETPROFITTZ")),
                "roe": _number(row.get("ROEJQ")),
                "grossMargin": _number(row.get("XSMLL")),
                "netMargin": _number(row.get("XSJLL")),
                "debtRatio": _number(row.get("ZCFZL")),
                "operatingCashFlowPerShare": _number(row.get("MGJYXJJE")),
                "sourceRecordId": f"eastmoney:{market}.{symbol}:{report_date}",
            }
        return sorted(
            output_by_period.values(),
            key=lambda item: item["reportDate"],
            reverse=True,
        )[:max(1, min(20, limit))]

    async def financial_snapshot(self, code: str) -> Dict[str, Any]:
        rows = await self.financial_history(code, 1)
        if not rows:
            raise RuntimeError(f"AKShare 没有返回 {code} 的财务指标")
        return rows[0]

    async def security_news(self, code: str, limit: int) -> List[Dict[str, Any]]:
        function = getattr(self.ak, "stock_news_em", None)
        if function is None:
            raise RuntimeError("当前 AKShare 版本没有个股新闻接口")
        symbol = code.split(".", 1)[1]
        rows = _records(await self._call(function, symbol=symbol))
        received_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        output = []
        for row in rows:
            title = _first_text(row, "新闻标题", "标题", "title")
            if not title:
                continue
            summary = _first_text(row, "新闻内容", "内容", "摘要", "content")[:600]
            published_at = _published_text(
                row.get("发布时间") or row.get("时间") or row.get("日期") or row.get("publish_time")
            )
            url = _first_text(row, "新闻链接", "链接", "网址", "url")
            source = _first_text(row, "文章来源", "来源", "媒体名称", "source") or "东方财富"
            unverified = any(word in f"{title}{summary}" for word in ("传闻", "网传", "消息称", "据悉"))
            output.append({
                "sourceId": _source_id("news", title, published_at, url),
                "kind": "news",
                "title": title[:240],
                "summary": summary,
                "source": source[:80],
                "url": url[:1000],
                "publishedAt": published_at,
                "receivedAt": received_at,
                "symbols": [code],
                "eventTypes": _event_types(title, summary),
                "verificationStatus": "unverified" if unverified else "reported",
            })
        output.sort(key=lambda item: item["publishedAt"], reverse=True)
        return output[:max(1, min(20, limit))]

    async def company_announcements(self, code: str, days: int, limit: int) -> List[Dict[str, Any]]:
        function = getattr(self.ak, "stock_notice_report", None)
        if function is None:
            raise RuntimeError("当前 AKShare 版本没有公司公告接口")
        symbol = code.split(".", 1)[1]
        end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        dates = [(end - timedelta(days=index)).strftime("%Y%m%d") for index in range(max(1, min(30, days)))]
        frames = await asyncio.gather(
            *(self._call(function, symbol="全部", date=value) for value in dates),
            return_exceptions=True,
        )
        received_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        output = []
        for frame in frames:
            if isinstance(frame, Exception):
                continue
            for row in _records(frame):
                row_code = _first_text(row, "代码", "股票代码", "SECURITY_CODE")
                if row_code and row_code.zfill(6) != symbol:
                    continue
                title = _first_text(row, "公告标题", "标题", "NOTICE_TITLE")
                if not title:
                    continue
                published_at = _published_text(
                    row.get("公告日期") or row.get("公告时间") or row.get("NOTICE_DATE")
                )
                url = _first_text(row, "网址", "公告链接", "链接", "url")
                summary = _first_text(row, "公告类型", "类型", "COLUMN_NAME")
                output.append({
                    "sourceId": _source_id("announcement", title, published_at, url),
                    "kind": "announcement",
                    "title": title[:240],
                    "summary": summary[:600],
                    "source": "上市公司公告",
                    "url": url[:1000],
                    "publishedAt": published_at,
                    "receivedAt": received_at,
                    "symbols": [code],
                    "eventTypes": _event_types(title, summary),
                    "verificationStatus": "official",
                })
        deduped = {item["sourceId"]: item for item in output}
        ranked = sorted(deduped.values(), key=lambda item: item["publishedAt"], reverse=True)
        return ranked[:max(1, min(20, limit))]

    async def stock_universe_snapshot(self) -> List[Dict[str, Any]]:
        output = []
        for row in await self._spot_table():
            symbol = str(row.get("代码") or "").strip()
            code = map_symbol(symbol)
            name = _text(row.get("名称"))
            if not code or not name:
                continue
            output.append({
                "code": code,
                "name": name,
                "market": _market_name(code),
                "price": _number(row.get("最新价")),
                "changePercent": _number(row.get("涨跌幅")),
                "peRatio": _number(row.get("市盈率-动态")),
                "pbRatio": _number(row.get("市净率")),
                "marketCap": _number(row.get("总市值")),
                "amount": _number(row.get("成交额")),
                "turnoverRate": _number(row.get("换手率")),
                "dataTime": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            })
        return output

    async def sector_catalog(self, category: str) -> List[Dict[str, Any]]:
        eastmoney_function = (
            self.ak.stock_board_industry_name_em
            if category == "industry"
            else self.ak.stock_board_concept_name_em
        )
        try:
            rows = _records(await self._call(eastmoney_function))
            name_key, code_key, source_kind = "板块名称", "板块代码", category
        except Exception:
            ths_function = (
                self.ak.stock_board_industry_name_ths
                if category == "industry"
                else self.ak.stock_board_concept_name_ths
            )
            rows = _records(await self._call(ths_function))
            name_key, code_key, source_kind = "name", "code", f"{category}_ths"
        return [
            {
                "kind": source_kind,
                "code": _text(row.get(code_key)) or "",
                "name": _text(row.get(name_key)) or "",
            }
            for row in rows
            if _text(row.get(code_key)) and _text(row.get(name_key))
        ]

    async def sector_scan_snapshot(self, category: str) -> List[Dict[str, Any]]:
        if category != "industry":
            raise RuntimeError("首版板块筛选仅支持行业板块")
        eastmoney_error: Optional[Exception] = None
        try:
            fund_flow_function = getattr(self.ak, "stock_sector_fund_flow_rank", None)
            periods = ("今日", "5日", "10日") if fund_flow_function else ()
            results = await asyncio.gather(
                self._call(self.ak.stock_board_industry_name_em),
                *(
                    self._call(
                        fund_flow_function,
                        indicator=period,
                        sector_type="行业资金流",
                    )
                    for period in periods
                ),
                return_exceptions=True,
            )
            if isinstance(results[0], Exception):
                raise results[0]
            summary_frame = results[0]
            period_funds = {
                period: {
                    str(row.get("名称") or "").strip(): row
                    for row in _records(frame)
                    if _text(row.get("名称"))
                }
                for period, frame in zip(periods, results[1:])
                if not isinstance(frame, Exception)
            }
            output = []
            for row in _records(summary_frame):
                code = _text(row.get("板块代码"))
                name = _text(row.get("板块名称"))
                if not code or not name:
                    continue
                today_fund = period_funds.get("今日", {}).get(name, {})
                five_day_fund = period_funds.get("5日", {}).get(name, {})
                ten_day_fund = period_funds.get("10日", {}).get(name, {})
                output.append({
                    "kind": "industry",
                    "code": code,
                    "name": name,
                    "price": _number(row.get("最新价")),
                    "changePercent": _number(row.get("涨跌幅")),
                    "marketCap": _number(row.get("总市值")),
                    "turnoverRate": _number(row.get("换手率")),
                    "netInflow": _number(today_fund.get("今日主力净流入-净额")),
                    "change5d": _number(five_day_fund.get("5日涨跌幅")),
                    "netInflow5d": _number(five_day_fund.get("5日主力净流入-净额")),
                    "change10d": _number(ten_day_fund.get("10日涨跌幅")),
                    "netInflow10d": _number(ten_day_fund.get("10日主力净流入-净额")),
                    "advancers": _number(row.get("上涨家数")),
                    "decliners": _number(row.get("下跌家数")),
                    "leader": _text(row.get("领涨股票")),
                    "leaderChangePercent": _number(row.get("领涨股票-涨跌幅")),
                    "dataTime": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
                    "source": "akshare-eastmoney",
                })
            if output:
                return output
            raise RuntimeError("东方财富没有返回行业板块批量快照")
        except Exception as error:
            eastmoney_error = error

        try:
            summary_frame, catalog_frame = await asyncio.gather(
                self._call(self.ak.stock_board_industry_summary_ths),
                self._call(self.ak.stock_board_industry_name_ths),
            )
            codes = {
                str(row.get("name") or "").strip(): str(row.get("code") or "").strip()
                for row in _records(catalog_frame)
            }
            output = []
            for row in _records(summary_frame):
                name = _text(row.get("板块"))
                if not name or not codes.get(name):
                    continue
                output.append({
                    "kind": "industry_ths",
                    "code": codes[name],
                    "name": name,
                    "changePercent": _number(row.get("涨跌幅")),
                    "amount": _number(row.get("总成交额")),
                    "netInflow": _number(row.get("净流入")),
                    "advancers": _number(row.get("上涨家数")),
                    "decliners": _number(row.get("下跌家数")),
                    "averagePrice": _number(row.get("均价")),
                    "leader": _text(row.get("领涨股")),
                    "leaderPrice": _number(row.get("领涨股-最新价")),
                    "leaderChangePercent": _number(row.get("领涨股-涨跌幅")),
                    "dataTime": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
                    "source": "akshare-ths",
                })
            if output:
                return output
            raise RuntimeError("同花顺没有返回行业板块批量快照")
        except Exception as ths_error:
            raise RuntimeError(
                f"东方财富：{eastmoney_error}；同花顺：{ths_error}"
            ) from ths_error

    async def sector_snapshot(self, category: str, code: str, name: str) -> Dict[str, Any]:
        if category.endswith("_ths"):
            function = (
                self.ak.stock_board_industry_info_ths
                if category == "industry_ths"
                else self.ak.stock_board_concept_info_ths
            )
            values = {
                str(row.get("项目") or "").strip(): row.get("值")
                for row in _records(await self._call(function, symbol=name))
            }
            if not values:
                raise RuntimeError(f"AKShare 同花顺没有返回板块 {name} 的快照")
            advancers, decliners = _breadth(values.get("涨跌家数"))
            return {
                "open": _display_number(values.get("今开")),
                "previousClose": _display_number(values.get("昨收")),
                "low": _display_number(values.get("最低")),
                "high": _display_number(values.get("最高")),
                "changePercent": _display_number(values.get("板块涨幅")),
                "volume": _display_number(values.get("成交量(万手)"), 10_000),
                "amount": _display_number(values.get("成交额(亿)"), 100_000_000),
                "netInflow": _display_number(values.get("资金净流入(亿)"), 100_000_000),
                "advancers": advancers,
                "decliners": decliners,
                "dataTime": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            }
        function = (
            self.ak.stock_board_industry_spot_em
            if category == "industry"
            else self.ak.stock_board_concept_spot_em
        )
        values = {
            str(row.get("item") or "").strip(): row.get("value")
            for row in _records(await self._call(function, symbol=code))
        }
        if not values:
            raise RuntimeError(f"AKShare 没有返回板块 {code} 的快照")
        return {
            "price": _number(values.get("最新")),
            "changePercent": _number(values.get("涨跌幅")),
            "change": _number(values.get("涨跌额")),
            "open": _number(values.get("开盘")),
            "high": _number(values.get("最高")),
            "low": _number(values.get("最低")),
            "volume": _number(values.get("成交量")),
            "amount": _number(values.get("成交额")),
            "turnoverRate": _number(values.get("换手率")),
            "dataTime": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
        }

    async def sector_bars(self, category: str, name: str, count: int) -> List[Dict[str, Any]]:
        end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        start = end - timedelta(days=max(240, count * 3))
        if category.endswith("_ths"):
            function = (
                self.ak.stock_board_industry_index_ths
                if category == "industry_ths"
                else self.ak.stock_board_concept_index_ths
            )
            frame = await self._call(
                function,
                symbol=name,
                start_date=start.strftime("%Y%m%d"),
                end_date=end.strftime("%Y%m%d"),
            )
        elif category == "industry":
            frame = await self._call(
                self.ak.stock_board_industry_hist_em,
                symbol=name,
                start_date=start.strftime("%Y%m%d"),
                end_date=end.strftime("%Y%m%d"),
                period="日k",
                adjust="qfq",
            )
        else:
            frame = await self._call(
                self.ak.stock_board_concept_hist_em,
                symbol=name,
                start_date=start.strftime("%Y%m%d"),
                end_date=end.strftime("%Y%m%d"),
                period="daily",
                adjust="qfq",
            )
        output = [
            {
                "time": _date_text(row.get("日期")) or "",
                "open": _number(row.get("开盘") if "开盘" in row else row.get("开盘价")),
                "close": _number(row.get("收盘") if "收盘" in row else row.get("收盘价")),
                "high": _number(row.get("最高") if "最高" in row else row.get("最高价")),
                "low": _number(row.get("最低") if "最低" in row else row.get("最低价")),
                "volume": _number(row.get("成交量")),
                "amount": _number(row.get("成交额")),
            }
            for row in _records(frame)[-count:]
        ]
        if not output:
            raise RuntimeError(f"AKShare 没有返回板块 {name} 的历史行情")
        return output

    async def sector_constituents(self, category: str, code: str, name: str) -> List[Dict[str, Any]]:
        if category.endswith("_ths"):
            function_name = (
                "stock_board_industry_cons_ths"
                if category == "industry_ths"
                else "stock_board_concept_cons_ths"
            )
            function = getattr(self.ak, function_name, None)
            frame = await self._call(function, symbol=name) if function else await self._call(
                _ths_sector_constituent_rows,
                category,
                code,
                self.timeout,
            )
        else:
            function = (
                self.ak.stock_board_industry_cons_em
                if category == "industry"
                else self.ak.stock_board_concept_cons_em
            )
            frame = await self._call(function, symbol=code)
        output = []
        for row in _records(frame):
            symbol = str(row.get("代码") or "").strip()
            normalized = map_symbol(symbol)
            if not normalized:
                continue
            output.append({
                "code": normalized,
                "name": _text(row.get("名称")) or symbol,
                "price": _display_number(row.get("最新价") if "最新价" in row else row.get("现价")),
                "changePercent": _display_number(
                    row.get("涨跌幅") if "涨跌幅" in row else row.get("涨跌幅(%)"),
                ),
                "amount": _display_number(row.get("成交额")),
                "turnoverRate": _display_number(
                    row.get("换手率") if "换手率" in row else row.get("换手(%)"),
                ),
                "peRatio": _display_number(
                    row.get("市盈率-动态") if "市盈率-动态" in row else row.get("市盈率"),
                ),
                "pbRatio": _display_number(row.get("市净率")),
            })
        if not output:
            raise RuntimeError(f"AKShare 没有返回板块 {code} 的成分股")
        return output

    async def index_snapshot(self, code: str, category: str) -> Dict[str, Any]:
        symbol = code[-6:]
        frame = await self._call(self.ak.stock_zh_index_spot_em, symbol=category)
        for row in _records(frame):
            if str(row.get("代码") or "").strip() != symbol:
                continue
            return {
                "code": code,
                "name": _text(row.get("名称")) or symbol,
                "price": _number(row.get("最新价")),
                "changePercent": _number(row.get("涨跌幅")),
                "change": _number(row.get("涨跌额")),
                "open": _number(row.get("今开")),
                "high": _number(row.get("最高")),
                "low": _number(row.get("最低")),
                "volume": _number(row.get("成交量")),
                "amount": _number(row.get("成交额")),
                "dataTime": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            }
        raise RuntimeError(f"AKShare 没有返回指数 {code} 的快照")

    async def index_bars(self, symbol: str, count: int) -> List[Dict[str, Any]]:
        end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        start = end - timedelta(days=max(240, count * 3))
        frame = await self._call(
            self.ak.stock_zh_index_daily_em,
            symbol=symbol,
            start_date=start.strftime("%Y%m%d"),
            end_date=end.strftime("%Y%m%d"),
        )
        output = [
            {
                "time": _date_text(row.get("date")) or "",
                "open": _number(row.get("open")),
                "close": _number(row.get("close")),
                "high": _number(row.get("high")),
                "low": _number(row.get("low")),
                "volume": _number(row.get("volume")),
                "amount": _number(row.get("amount")),
            }
            for row in _records(frame)[-count:]
        ]
        if not output:
            raise RuntimeError(f"AKShare 没有返回指数 {symbol} 的历史行情")
        return output

    async def market_overview(self) -> Dict[str, Any]:
        rows = await self._spot_table()
        changes = [
            value
            for row in rows
            if (value := _number(row.get("涨跌幅"))) is not None
        ]
        if not changes:
            raise RuntimeError("AKShare 没有返回有效的全市场涨跌数据")
        sorted_changes = sorted(changes)
        middle = len(sorted_changes) // 2
        median = (
            sorted_changes[middle]
            if len(sorted_changes) % 2
            else (sorted_changes[middle - 1] + sorted_changes[middle]) / 2
        )
        leaders = sorted(
            (
                {
                    "code": str(row.get("代码") or ""),
                    "name": _text(row.get("名称")) or "",
                    "changePercent": _number(row.get("涨跌幅")),
                }
                for row in rows
                if _number(row.get("涨跌幅")) is not None
            ),
            key=lambda item: item["changePercent"],
            reverse=True,
        )[:5]
        return {
            "asOf": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            "advancers": sum(value > 0 for value in changes),
            "decliners": sum(value < 0 for value in changes),
            "unchanged": sum(value == 0 for value in changes),
            "medianChangePercent": round(median, 4),
            "totalAmount": sum(_number(row.get("成交额")) or 0 for row in rows),
            "leaders": leaders,
        }

    async def close(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)
