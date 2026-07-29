from datetime import date, datetime
import math
from statistics import mean, stdev
from typing import Any, Dict, List
from uuid import uuid4
from zoneinfo import ZoneInfo

from .factors import FACTOR_VERSION, FactorEngine
from .repository import QuantRepository


def _drawdown(values: List[float]) -> float:
    peak = values[0] if values else 1.0
    result = 0.0
    for value in values:
        peak = max(peak, value)
        result = min(result, value / peak - 1)
    return result


class BacktestEngine:
    def __init__(self, repository: QuantRepository, factors: FactorEngine):
        self.repository = repository
        self.factors = factors

    async def run(
        self,
        style: str,
        start_date: str,
        end_date: str,
        top_n: int = 20,
        rebalance_days: int = 20,
        commission_rate: float = .0003,
        stamp_tax_rate: float = .0005,
        slippage_rate: float = .0005,
    ) -> Dict[str, Any]:
        dates = await self.repository.trading_dates(start_date, end_date)
        if len(dates) < 22:
            return {
                "kind": "strategy_backtest",
                "status": "unavailable",
                "error": "历史交易日不足，至少需要22个交易日",
            }
        safe_top_n = max(5, min(100, top_n))
        safe_rebalance = max(5, min(60, rebalance_days))
        prices = await self.repository.prices_between(dates[0], dates[-1])
        price_map = {
            (row["trade_date"], row["instrument_id"]): row
            for row in prices
        }
        rebalance_indexes = list(range(1, len(dates), safe_rebalance))
        if rebalance_indexes[-1] != len(dates) - 1:
            rebalance_indexes.append(len(dates) - 1)

        equity = 1.0
        benchmark_equity = 1.0
        curve = [{"date": dates[0], "equity": 1.0, "benchmark": 1.0}]
        period_returns: List[float] = []
        holdings: List[str] = []
        turnover_values: List[float] = []
        rebalance_records = []

        for position in range(len(rebalance_indexes) - 1):
            execution_index = rebalance_indexes[position]
            exit_index = rebalance_indexes[position + 1]
            signal_date = dates[execution_index - 1]
            execution_date = dates[execution_index]
            exit_date = dates[exit_index]
            ranked = await self.factors.calculate(signal_date, style)
            candidates = []
            for item in ranked:
                execution = price_map.get((execution_date, item["instrumentId"]))
                if not execution or not execution.get("open"):
                    continue
                if isinstance(execution.get("pct_change"), (int, float)) and execution["pct_change"] >= 9.8:
                    continue
                candidates.append(item["instrumentId"])
                if len(candidates) >= safe_top_n:
                    break
            if not candidates:
                continue

            forced_holdings = []
            for code in holdings:
                execution = price_map.get((execution_date, code))
                if execution and isinstance(execution.get("pct_change"), (int, float)) and execution["pct_change"] <= -9.8:
                    forced_holdings.append(code)
            target = list(dict.fromkeys([*forced_holdings, *candidates]))[:safe_top_n]
            previous = set(holdings)
            current = set(target)
            turnover = 1.0 if not previous else 1 - len(previous & current) / max(len(previous), 1)
            turnover_values.append(turnover)
            cost = turnover * (2 * commission_rate + 2 * slippage_rate + stamp_tax_rate)

            returns = []
            for code in target:
                entry = price_map.get((execution_date, code))
                exit_row = price_map.get((exit_date, code))
                entry_price = entry.get("open") if entry else None
                exit_price = exit_row.get("open") if exit_row else None
                if entry_price and exit_price:
                    returns.append(exit_price / entry_price - 1)
            if not returns:
                continue
            period_return = mean(returns) - cost
            equity *= 1 + period_return
            period_returns.append(period_return)

            benchmark_returns = []
            for item in ranked:
                entry = price_map.get((execution_date, item["instrumentId"]))
                exit_row = price_map.get((exit_date, item["instrumentId"]))
                if entry and exit_row and entry.get("open") and exit_row.get("open"):
                    benchmark_returns.append(exit_row["open"] / entry["open"] - 1)
            benchmark_return = mean(benchmark_returns) if benchmark_returns else 0.0
            benchmark_equity *= 1 + benchmark_return
            curve.append({
                "date": exit_date,
                "equity": round(equity, 6),
                "benchmark": round(benchmark_equity, 6),
            })
            rebalance_records.append({
                "signalDate": signal_date,
                "executionDate": execution_date,
                "exitDate": exit_date,
                "holdings": target,
                "turnover": round(turnover, 4),
                "cost": round(cost, 6),
                "return": round(period_return, 6),
            })
            holdings = target

        if not period_returns:
            return {
                "kind": "strategy_backtest",
                "status": "unavailable",
                "error": "没有形成可执行的历史调仓组合",
            }
        start = date.fromisoformat(curve[0]["date"])
        end = date.fromisoformat(curve[-1]["date"])
        elapsed_days = max(1, (end - start).days)
        annual_return = equity ** (365 / elapsed_days) - 1
        periods_per_year = 252 / safe_rebalance
        volatility = stdev(period_returns) * math.sqrt(periods_per_year) if len(period_returns) > 1 else 0.0
        sharpe = (mean(period_returns) * periods_per_year) / volatility if volatility else None
        result = {
            "totalReturn": round((equity - 1) * 100, 4),
            "annualReturn": round(annual_return * 100, 4),
            "benchmarkReturn": round((benchmark_equity - 1) * 100, 4),
            "excessReturn": round((equity - benchmark_equity) * 100, 4),
            "maxDrawdown": round(_drawdown([item["equity"] for item in curve]) * 100, 4),
            "annualVolatility": round(volatility * 100, 4),
            "sharpe": round(sharpe, 4) if sharpe is not None else None,
            "winRate": round(sum(value > 0 for value in period_returns) / len(period_returns) * 100, 2),
            "averageTurnover": round(mean(turnover_values) * 100, 2),
            "rebalanceCount": len(rebalance_records),
            "curve": curve,
            "rebalances": rebalance_records,
        }
        created_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        run = {
            "runId": uuid4().hex,
            "kind": "strategy_backtest",
            "status": "ok",
            "style": style,
            "startDate": start_date,
            "endDate": end_date,
            "factorVersion": FACTOR_VERSION,
            "createdAt": created_at,
            "parameters": {
                "topN": safe_top_n,
                "rebalanceDays": safe_rebalance,
                "commissionRate": commission_rate,
                "stampTaxRate": stamp_tax_rate,
                "slippageRate": slippage_rate,
                "signalTiming": "前一交易日收盘生成信号，下一交易日开盘执行",
                "limitPolicy": "涨停不买、跌停不卖",
                "benchmark": "同期合格股票池等权",
            },
            "result": result,
            "warnings": [
                "回测结果不代表未来收益",
                "未模拟盘口冲击、部分成交和融资成本",
            ],
        }
        await self.repository.save_backtest(run)
        return run
