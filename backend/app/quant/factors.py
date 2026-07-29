from collections import defaultdict
from datetime import datetime
import math
from statistics import stdev
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from .repository import QuantRepository


FACTOR_VERSION = "multi-factor-v1"
STYLE_WEIGHTS = {
    "balanced": {"quality": .25, "growth": .20, "value": .20, "momentum": .20, "risk": .15},
    "quality": {"quality": .55, "growth": .15, "value": .10, "momentum": .05, "risk": .15},
    "growth": {"quality": .15, "growth": .55, "value": .05, "momentum": .15, "risk": .10},
    "value": {"quality": .15, "growth": .05, "value": .55, "momentum": .05, "risk": .20},
    "momentum": {"quality": .05, "growth": .05, "value": .05, "momentum": .60, "risk": .25},
}
MIN_COVERAGE = {
    "balanced": .35,
    "quality": .50,
    "growth": .50,
    "value": .50,
    "momentum": .50,
}


def _finite(value: Any) -> Optional[float]:
    if not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _period_return(closes: List[float], days: int) -> Optional[float]:
    if len(closes) < days + 1 or not closes[-days - 1]:
        return None
    return (closes[-1] / closes[-days - 1] - 1) * 100


def _volatility(closes: List[float], days: int = 20) -> Optional[float]:
    if len(closes) < days + 1:
        return None
    returns = [closes[index] / closes[index - 1] - 1 for index in range(len(closes) - days, len(closes))]
    return stdev(returns) * math.sqrt(252) * 100 if len(returns) > 1 else None


def _drawdown(closes: List[float], days: int = 60) -> Optional[float]:
    if len(closes) < days:
        return None
    peak = closes[-days]
    result = 0.0
    for close in closes[-days:]:
        peak = max(peak, close)
        result = min(result, close / peak - 1)
    return result * 100


def _percentiles(values: Dict[str, Optional[float]]) -> Dict[str, float]:
    ranked = sorted((value, key) for key, value in values.items() if value is not None)
    if not ranked:
        return {}
    if len(ranked) == 1:
        return {ranked[0][1]: 50.0}
    output = {}
    index = 0
    while index < len(ranked):
        end = index + 1
        while end < len(ranked) and ranked[end][0] == ranked[index][0]:
            end += 1
        average_rank = (index + end - 1) / 2
        score = average_rank / (len(ranked) - 1) * 100
        for _, key in ranked[index:end]:
            output[key] = score
        index = end
    return output


def _mean(values: Iterable[Optional[float]]) -> Optional[float]:
    available = [value for value in values if value is not None]
    return sum(available) / len(available) if available else None


class FactorEngine:
    def __init__(self, repository: QuantRepository):
        self.repository = repository

    async def calculate(self, as_of: str, style: str = "balanced") -> List[Dict[str, Any]]:
        safe_style = style if style in STYLE_WEIGHTS else "balanced"
        history_rows = await self.repository.price_history(as_of, 130)
        valuations = await self.repository.valuations_as_of(as_of)
        financials = await self.repository.financials_as_of(as_of)
        grouped: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for row in history_rows:
            grouped[row["instrument_id"]].append(row)

        metrics: Dict[str, Dict[str, Any]] = {}
        for instrument_id, rows in grouped.items():
            rows.sort(key=lambda item: item["trade_date"])
            latest = rows[-1]
            name = str(latest.get("name") or instrument_id)
            closes = [float(row["close"]) for row in rows if _finite(row.get("close")) not in (None, 0)]
            amounts = [float(row["amount"]) for row in rows[-20:] if _finite(row.get("amount")) is not None]
            if len(closes) < 21 or "ST" in name.upper() or _finite(latest.get("close")) in (None, 0):
                continue
            financial = financials.get(instrument_id, {})
            valuation = valuations.get(instrument_id, {})
            metrics[instrument_id] = {
                "instrumentId": instrument_id,
                "code": instrument_id,
                "name": name,
                "industry": latest.get("industry") or "未分类",
                "price": _finite(latest.get("close")),
                "changePercent": _finite(latest.get("pct_change")),
                "asOf": latest.get("trade_date"),
                "averageAmount20d": _mean(amounts),
                "raw": {
                    "roe": _finite(financial.get("roe")),
                    "grossMargin": _finite(financial.get("gross_margin")),
                    "cashFlowPerShare": _finite(financial.get("operating_cash_flow_per_share")),
                    "debtSafety": -financial["debt_ratio"] if _finite(financial.get("debt_ratio")) is not None else None,
                    "revenueGrowth": _finite(financial.get("revenue_yoy")),
                    "profitGrowth": _finite(financial.get("net_profit_yoy")),
                    "earningsYield": -valuation["pe_ttm"] if _finite(valuation.get("pe_ttm")) and valuation["pe_ttm"] > 0 else None,
                    "bookYield": -valuation["pb"] if _finite(valuation.get("pb")) and valuation["pb"] > 0 else None,
                    "return20d": _period_return(closes, 20),
                    "return60d": _period_return(closes, 60),
                    "return120d": _period_return(closes, 120),
                    "lowVolatility": -_volatility(closes) if _volatility(closes) is not None else None,
                    "drawdownSafety": _drawdown(closes),
                    "liquidity": math.log10(max(_mean(amounts) or 1, 1)),
                },
                "financialReportDate": (
                    financial.get("report_date").isoformat()
                    if financial.get("report_date") else None
                ),
                "financialAnnouncedAt": (
                    financial.get("announced_at").isoformat()
                    if financial.get("announced_at") else None
                ),
                "valuationDate": (
                    valuation.get("trade_date").isoformat()
                    if valuation.get("trade_date") else None
                ),
                "dataSources": {
                    "price": latest.get("source"),
                    **({"valuation": valuation.get("source")} if valuation else {}),
                    **({"financial": financial.get("source")} if financial else {}),
                },
            }

        metric_names = list(next(iter(metrics.values()))["raw"]) if metrics else []
        global_scores = {
            metric: _percentiles({key: item["raw"][metric] for key, item in metrics.items()})
            for metric in metric_names
        }
        by_industry: Dict[str, List[str]] = defaultdict(list)
        for key, item in metrics.items():
            by_industry[item["industry"]].append(key)
        neutral_scores: Dict[str, Dict[str, Optional[float]]] = defaultdict(dict)
        for metric in metric_names:
            for industry, keys in by_industry.items():
                local = _percentiles({key: metrics[key]["raw"][metric] for key in keys}) if len(keys) >= 5 else {}
                for key in keys:
                    global_value = global_scores[metric].get(key)
                    local_value = local.get(key)
                    neutral_scores[key][metric] = (
                        local_value * .7 + global_value * .3
                        if local_value is not None and global_value is not None
                        else global_value
                    )

        calculated_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        output = []
        for key, item in metrics.items():
            scores = neutral_scores[key]
            factors = {
                "quality": _mean(scores.get(name) for name in ("roe", "grossMargin", "cashFlowPerShare", "debtSafety")),
                "growth": _mean(scores.get(name) for name in ("revenueGrowth", "profitGrowth")),
                "value": _mean(scores.get(name) for name in ("earningsYield", "bookYield")),
                "momentum": _mean(scores.get(name) for name in ("return20d", "return60d", "return120d")),
                "risk": _mean(scores.get(name) for name in ("lowVolatility", "drawdownSafety", "liquidity")),
            }
            weights = STYLE_WEIGHTS[safe_style]
            available_weight = sum(weight for name, weight in weights.items() if factors[name] is not None)
            coverage = available_weight / sum(weights.values())
            if coverage < MIN_COVERAGE[safe_style]:
                continue
            score = sum(factors[name] * weight for name, weight in weights.items() if factors[name] is not None) / available_weight
            confidence = "high" if coverage >= .8 else "medium" if coverage >= .55 else "low"
            output.append({
                **{name: value for name, value in item.items() if name != "raw"},
                **{name: round(value, 2) if value is not None else None for name, value in factors.items()},
                "rawMetrics": {
                    name: round(value, 4) if value is not None else None
                    for name, value in item["raw"].items()
                },
                "score": round(score, 2),
                "coverage": round(coverage, 4),
                "confidence": confidence,
                "calculatedAt": calculated_at,
                "factorVersion": FACTOR_VERSION,
            })

        output.sort(key=lambda item: (item["score"], item.get("averageAmount20d") or 0), reverse=True)
        industry_counts: Dict[str, int] = defaultdict(int)
        for rank, item in enumerate(output, start=1):
            item["rank"] = rank
            industry_counts[item["industry"]] += 1
            item["industryRank"] = industry_counts[item["industry"]]
        await self.repository.save_factor_snapshot(as_of, safe_style, FACTOR_VERSION, output)
        return output

    async def screen(self, as_of: str, style: str = "balanced", limit: int = 5) -> Dict[str, Any]:
        rows = await self.calculate(as_of, style)
        safe_limit = max(1, min(200, limit))
        return {
            "kind": "factor_screen",
            "status": "ok" if rows else "unavailable",
            "style": style if style in STYLE_WEIGHTS else "balanced",
            "asOf": as_of,
            "factorVersion": FACTOR_VERSION,
            "universeCount": len(rows),
            "stocks": rows[:safe_limit],
            "criteria": {
                "pointInTime": True,
                "industryNeutralized": True,
                "missingDataPolicy": "缺失因子不计分且降低覆盖率；覆盖率不足的股票直接排除",
                "minimumCoverage": MIN_COVERAGE.get(style, MIN_COVERAGE["balanced"]),
            },
            "dataSources": sorted({
                source
                for row in rows[:safe_limit]
                for source in row.get("dataSources", {}).values()
                if source
            }),
            "warnings": [
                "当前结果按历史数据截面计算，不构成投资建议",
                *(["当前股票池缺少部分财务或估值因子，已通过覆盖率披露"] if any(row["coverage"] < .8 for row in rows[:safe_limit]) else []),
            ],
        }

    async def compare(self, as_of: str, codes: List[str], style: str = "balanced") -> Dict[str, Any]:
        wanted = set(codes[:10])
        rows = [row for row in await self.calculate(as_of, style) if row["instrumentId"] in wanted]
        return {
            "kind": "factor_comparison",
            "status": "ok" if rows else "unavailable",
            "asOf": as_of,
            "style": style,
            "factorVersion": FACTOR_VERSION,
            "stocks": rows,
            "missingCodes": sorted(wanted - {row["instrumentId"] for row in rows}),
        }
