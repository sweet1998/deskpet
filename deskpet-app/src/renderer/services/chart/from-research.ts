import type { ResearchPrepareResult } from '../../../shared/research'
import type { ChartSeries } from './series-store'
import type { RawBar } from './candles'

function firstSecurity(context: Record<string, any>): Record<string, any> | null {
  const market = context.market && typeof context.market === 'object' ? context.market : {}
  const securities = Array.isArray(market.securities) ? market.securities : []
  const withBars = securities.find((item: any) => Array.isArray(item?.dailyBars) && item.dailyBars.length)
  return withBars || null
}

export function chartSeriesFromResearch(prepared: ResearchPrepareResult): ChartSeries | null {
  if (!prepared.context || prepared.scope !== 'in_scope') return null
  const context = prepared.context as Record<string, any>

  if (context.kind === 'strategy_backtest' && context.status === 'ok') {
    const result = context.result && typeof context.result === 'object' ? context.result : {}
    const curve = Array.isArray(result.curve) ? result.curve : []
    if (!curve.length) return null
    return {
      kind: 'equity',
      title: '策略净值',
      curve,
      ...(typeof result.rebalanceCount === 'number' ? { rebalanceCount: result.rebalanceCount } : {}),
      // Not CSI 300: the backtest benchmarks against an equal-weight basket of the
      // same eligible universe (quant/backtest.py), so the legend must say so.
      benchmarkLabel: '等权基准（同期合格股票池）',
    }
  }

  if (context.kind === 'security') {
    const security = firstSecurity(context)
    if (!security) return null
    return {
      kind: 'candles',
      title: String(security.name || '个股走势'),
      bars: security.dailyBars as RawBar[],
    }
  }

  if ((context.kind === 'sector' || context.kind === 'index') && Array.isArray(context.dailyBars)) {
    if (!context.dailyBars.length) return null
    return {
      kind: 'candles',
      title: String(context.name || (context.kind === 'index' ? '指数走势' : '板块走势')),
      bars: context.dailyBars as RawBar[],
    }
  }

  return null
}
