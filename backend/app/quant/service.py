import asyncio
from datetime import date, datetime, timedelta
from typing import Any, Awaitable, Callable, Dict, List, Optional
from zoneinfo import ZoneInfo

from ..market.providers.tushare import TushareProvider
from .backtest import BacktestEngine
from .factors import FactorEngine
from .repository import QuantRepository


ProgressCallback = Callable[[str], Awaitable[None]]
InstrumentFallback = Callable[[], Awaitable[List[Dict[str, Any]]]]


class QuantService:
    def __init__(
        self,
        repository: QuantRepository,
        provider: TushareProvider,
        instrument_fallback: Optional[InstrumentFallback] = None,
    ):
        self.repository = repository
        self.provider = provider
        self.factors = FactorEngine(repository)
        self.backtests = BacktestEngine(repository, self.factors)
        self.instrument_fallback = instrument_fallback
        self._refresh_lock = asyncio.Lock()

    async def start(self) -> None:
        await self.repository.start()

    async def status(self) -> Dict[str, Any]:
        summary = await self.repository.summary()
        return {
            "kind": "quant_data_status",
            "status": "ready" if summary["trading_days"] >= 21 else "needs_refresh",
            "provider": self.provider.name,
            "factorCapabilities": list(self.provider.capabilities),
            "historyDepth": "full" if summary["trading_days"] >= 121 else "limited",
            **summary,
        }

    async def refresh(
        self,
        start_date: str,
        end_date: str,
        include_valuation: bool = False,
        progress: Optional[ProgressCallback] = None,
        refresh_instruments: bool = False,
    ) -> Dict[str, Any]:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
        if start > end:
            raise ValueError("startDate 不能晚于 endDate")
        if (end - start).days > 550:
            raise ValueError("单次最多同步550个自然日")
        async with self._refresh_lock:
            errors = []
            existing = await self.repository.summary()
            if existing["instruments"] and not refresh_instruments:
                instrument_count = existing["instruments"]
                if progress:
                    await progress(f"复用本地主表中的 {instrument_count} 只证券，跳过低频主数据接口")
            else:
                if progress:
                    await progress("正在同步全市场证券主数据")
                try:
                    instruments = await self.provider.instrument_master()
                except Exception as error:
                    if self.instrument_fallback is None:
                        raise
                    instruments = await self.instrument_fallback()
                    errors.append(f"Tushare 证券主数据暂不可用，已使用全市场快照降级：{str(error)[:160]}")
                    if progress:
                        await progress("Tushare 证券主数据触发限频，已使用全市场快照建立基础主表")
                instrument_count = await self.repository.upsert_instruments(instruments)
            candidates = []
            current = start
            while current <= end:
                if current.weekday() < 5:
                    candidates.append(current.isoformat())
                current += timedelta(days=1)
            price_rows = 0
            trading_days = 0
            for index, trade_date in enumerate(candidates, start=1):
                try:
                    rows = await self.provider.market_daily(trade_date)
                    if rows:
                        price_rows += await self.repository.upsert_daily_prices(rows)
                        trading_days += 1
                except Exception as error:
                    errors.append(f"{trade_date}: {str(error)[:160]}")
                    if "频率超限" in str(error):
                        break
                if progress and (index == 1 or index % 10 == 0 or index == len(candidates)):
                    await progress(f"已检查 {index}/{len(candidates)} 个工作日，写入 {trading_days} 个交易日")

            valuation_rows = 0
            if include_valuation:
                try:
                    valuation = await self.provider.market_valuation(end.isoformat())
                    valuation_rows = await self.repository.upsert_daily_valuations(valuation)
                except Exception as error:
                    errors.append(f"估值数据: {str(error)[:160]}")
            summary = await self.repository.summary()
            return {
                "kind": "quant_data_refresh",
                "status": "ok" if trading_days else "unavailable",
                "requestedRange": {"from": start_date, "to": end_date},
                "instrumentCount": instrument_count,
                "tradingDaysWritten": trading_days,
                "priceRowsWritten": price_rows,
                "valuationRowsWritten": valuation_rows,
                "summary": summary,
                "warnings": errors[:20],
            }

    async def refresh_financials(
        self,
        codes: List[str],
        progress: Optional[ProgressCallback] = None,
    ) -> Dict[str, Any]:
        if "financial_history" not in self.provider.capabilities:
            return {
                "kind": "financial_refresh",
                "status": "unavailable",
                "error": "当前 Tushare Token 没有财务接口权限",
            }
        written = 0
        errors = []
        ingested_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        for index, code in enumerate(codes[:100], start=1):
            try:
                rows = await self.provider.financial_history(code, 20)
                written += await self.repository.upsert_financial_periods([{
                    "instrumentId": code,
                    **row,
                    "source": self.provider.name,
                    "ingestedAt": ingested_at,
                } for row in rows])
            except Exception as error:
                errors.append(f"{code}: {str(error)[:140]}")
            if progress:
                await progress(f"已同步 {index}/{min(len(codes), 100)} 只股票的财务历史")
        return {
            "kind": "financial_refresh",
            "status": "ok" if written else "unavailable",
            "rowsWritten": written,
            "warnings": errors,
        }

    async def screen(self, style: str = "balanced", limit: int = 5, as_of: Optional[str] = None) -> Dict[str, Any]:
        summary = await self.repository.summary()
        effective_date = as_of or summary.get("price_to")
        if not effective_date or summary["trading_days"] < 21:
            return {
                "kind": "factor_screen",
                "status": "unavailable",
                "stocks": [],
                "error": "本地量化数据库不足21个交易日，请先同步历史数据",
            }
        return await self.factors.screen(str(effective_date), style, limit)

    async def compare(self, codes: List[str], style: str = "balanced", as_of: Optional[str] = None) -> Dict[str, Any]:
        summary = await self.repository.summary()
        effective_date = as_of or summary.get("price_to")
        if not effective_date:
            return {"kind": "factor_comparison", "status": "unavailable", "stocks": []}
        return await self.factors.compare(str(effective_date), codes, style)

    async def backtest(
        self,
        style: str,
        start_date: str,
        end_date: str,
        top_n: int = 20,
        rebalance_days: int = 20,
    ) -> Dict[str, Any]:
        return await self.backtests.run(style, start_date, end_date, top_n, rebalance_days)
