import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from functools import partial
import math
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from .base import MarketProvider
from .eastmoney import _market_name, map_symbol


def _number(value: Any) -> Optional[float]:
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def _records(frame: Any) -> List[Dict[str, Any]]:
    if frame is None or getattr(frame, "empty", False):
        return []
    if isinstance(frame, list):
        return [dict(item) for item in frame if isinstance(item, dict)]
    return [dict(item) for item in frame.to_dict(orient="records")]


class SinaProvider(MarketProvider):
    """Sina full-market universe used only when the primary universe feed fails."""

    name = "akshare-sina"

    def __init__(self, timeout: float = 30.0, ak_module: Any = None):
        if ak_module is None:
            import akshare as ak_module
        self.ak = ak_module
        self.timeout = timeout
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="deskpet-sina")

    async def _call(self, function: Any, *args: Any, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(self.executor, partial(function, *args, **kwargs))
        try:
            return await asyncio.wait_for(future, timeout=self.timeout)
        except asyncio.TimeoutError as error:
            raise RuntimeError(f"新浪全市场请求超过 {self.timeout:g} 秒") from error

    async def search(self, query: str) -> List[Dict[str, str]]:
        raise RuntimeError("新浪备源不提供名称搜索")

    async def snapshot(self, code: str) -> Dict[str, Any]:
        raise RuntimeError("新浪备源不提供估值快照")

    async def daily_bars(self, code: str, count: int) -> List[Dict[str, Any]]:
        raise RuntimeError("新浪备源不提供筛选历史数据")

    async def stock_universe_snapshot(self) -> List[Dict[str, Any]]:
        function = getattr(self.ak, "stock_zh_a_spot", None)
        if function is None:
            raise RuntimeError("当前 AKShare 版本没有新浪全市场接口")
        rows = _records(await self._call(function))
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        output = []
        for row in rows:
            raw_code = str(row.get("代码") or "").strip().lower()
            symbol = "".join(character for character in raw_code if character.isdigit())[-6:]
            code = map_symbol(symbol)
            name = str(row.get("名称") or "").strip()
            if not code or not name:
                continue
            raw_time = str(row.get("时间戳") or "").strip()
            try:
                data_time = datetime.fromisoformat(f"{now.date().isoformat()}T{raw_time}").replace(
                    tzinfo=ZoneInfo("Asia/Shanghai"),
                ).isoformat()
            except ValueError:
                data_time = now.isoformat()
            output.append({
                "code": code,
                "name": name,
                "market": _market_name(code),
                "price": _number(row.get("最新价")),
                "changePercent": _number(row.get("涨跌幅")),
                "amount": _number(row.get("成交额")),
                "dataTime": data_time,
            })
        if not output:
            raise RuntimeError("新浪没有返回可用的 A 股全市场行情")
        return output

    async def close(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)
