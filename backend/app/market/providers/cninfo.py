from datetime import datetime, timedelta
from html import unescape
import re
import time
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

import httpx

from .base import MarketProvider


EVENT_KEYWORDS = {
    "earnings": ("业绩", "财报", "营收", "利润", "预增", "预减", "快报"),
    "buyback": ("回购",),
    "shareholding": ("增持", "减持", "持股变动", "质押", "解禁"),
    "regulatory": ("问询", "监管", "处罚", "立案", "警示函"),
    "restructuring": ("并购", "重组", "收购", "重大资产"),
    "contract": ("中标", "合同", "订单", "签约"),
    "risk": ("风险提示", "诉讼", "仲裁", "退市", "停牌"),
}


def _plain_text(value: Any) -> str:
    return unescape(re.sub(r"<[^>]+>", "", str(value or ""))).strip()


def _event_types(title: str) -> List[str]:
    values = [name for name, keywords in EVENT_KEYWORDS.items() if any(word in title for word in keywords)]
    return values or ["other"]


class CninfoProvider(MarketProvider):
    name = "cninfo-official"
    capabilities = ("official_announcements",)
    STOCK_LIST_URL = "https://www.cninfo.com.cn/new/data/szse_stock.json"
    QUERY_URL = "https://www.cninfo.com.cn/new/hisAnnouncement/query"
    PDF_ROOT = "https://static.cninfo.com.cn/"

    def __init__(self, timeout: float = 8.0, client: Optional[httpx.AsyncClient] = None):
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            timeout=timeout,
            headers={
                "User-Agent": "Mozilla/5.0 DeskpetMarket/1.0",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": "https://www.cninfo.com.cn/",
            },
        )
        self._stocks: Dict[str, Dict[str, Any]] = {}
        self._stocks_expires_at = 0.0

    async def search(self, query: str) -> List[Dict[str, str]]:
        return []

    async def snapshot(self, code: str) -> Dict[str, Any]:
        return {}

    async def daily_bars(self, code: str, count: int) -> List[Dict[str, Any]]:
        return []

    async def _stock_list(self) -> Dict[str, Dict[str, Any]]:
        if self._stocks and time.monotonic() < self._stocks_expires_at:
            return self._stocks
        response = await self.client.get(self.STOCK_LIST_URL)
        response.raise_for_status()
        rows = response.json().get("stockList") or []
        self._stocks = {
            str(item.get("code")): item
            for item in rows
            if item.get("code") and item.get("orgId")
        }
        self._stocks_expires_at = time.monotonic() + 24 * 60 * 60
        return self._stocks

    async def company_announcements(self, code: str, days: int, limit: int) -> List[Dict[str, Any]]:
        market, symbol = code.split(".", 1)
        stock = (await self._stock_list()).get(symbol)
        if not stock:
            raise RuntimeError(f"巨潮资讯没有找到 {code} 的证券主数据")
        end = datetime.now(ZoneInfo("Asia/Shanghai")).date()
        start = end - timedelta(days=max(1, min(30, days)))
        column, plate = {
            "SH": ("sse", "sh"),
            "SZ": ("szse", "sz"),
            "BJ": ("third", "neeq"),
        }.get(market, ("", ""))
        response = await self.client.post(self.QUERY_URL, data={
            "pageNum": "1",
            "pageSize": str(max(1, min(30, limit))),
            "column": column,
            "tabName": "fulltext",
            "plate": plate,
            "stock": f"{symbol},{stock['orgId']}",
            "searchkey": "",
            "secid": "",
            "category": "",
            "trade": "",
            "seDate": f"{start.isoformat()}~{end.isoformat()}",
            "sortName": "time",
            "sortType": "desc",
            "isHLtitle": "true",
        })
        response.raise_for_status()
        received_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        output = []
        for row in response.json().get("announcements") or []:
            if str(row.get("secCode") or "") != symbol:
                continue
            title = _plain_text(row.get("announcementTitle"))
            if not title:
                continue
            timestamp = row.get("announcementTime")
            published_at = ""
            if isinstance(timestamp, (int, float)):
                published_at = datetime.fromtimestamp(
                    timestamp / 1000,
                    ZoneInfo("Asia/Shanghai"),
                ).isoformat()
            announcement_id = str(row.get("announcementId") or "")
            path = str(row.get("adjunctUrl") or "").lstrip("/")
            output.append({
                "sourceId": f"cninfo:{announcement_id}" if announcement_id else f"cninfo:{symbol}:{timestamp}",
                "kind": "announcement",
                "title": title[:240],
                "summary": _plain_text(row.get("announcementTypeName"))[:600],
                "source": "巨潮资讯",
                "url": f"{self.PDF_ROOT}{path}" if path else "",
                "publishedAt": published_at,
                "receivedAt": received_at,
                "symbols": [code],
                "eventTypes": _event_types(title),
                "verificationStatus": "official",
            })
        return output[:max(1, min(20, limit))]

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
