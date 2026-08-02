export interface CurvePoint {
  time: string
  value: number
}

export interface EquityCurve {
  equity: CurvePoint[]
  benchmark: CurvePoint[]
}

interface RawCurvePoint {
  date?: unknown
  equity?: unknown
  benchmark?: unknown
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function toEquityCurve(curve: readonly RawCurvePoint[] | null | undefined): EquityCurve {
  if (!Array.isArray(curve)) return { equity: [], benchmark: [] }
  const equity: CurvePoint[] = []
  const benchmark: CurvePoint[] = []
  const seen = new Set<string>()

  for (const point of curve) {
    if (!point || typeof point !== 'object') continue
    const time = typeof point.date === 'string' ? point.date.trim() : ''
    if (!time || seen.has(time)) continue
    const equityValue = finite(point.equity)
    if (equityValue === null) continue
    seen.add(time)
    equity.push({ time, value: equityValue })
    const benchmarkValue = finite(point.benchmark)
    if (benchmarkValue !== null) benchmark.push({ time, value: benchmarkValue })
  }

  const byTime = (a: CurvePoint, b: CurvePoint) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)
  return { equity: equity.sort(byTime), benchmark: benchmark.sort(byTime) }
}

/**
 * The backend caps most context arrays at 20 entries. The curve is exempt, but a
 * mismatch against the reported rebalance count still means the chart is partial,
 * and a partial curve must not be presented as the full backtest.
 */
export function curveIsPartial(points: number, rebalanceCount: unknown): boolean {
  const expected = typeof rebalanceCount === 'number' && Number.isFinite(rebalanceCount)
    ? rebalanceCount
    : null
  return expected !== null && points > 0 && points < expected
}
