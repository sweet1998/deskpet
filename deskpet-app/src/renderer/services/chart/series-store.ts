import { shallowRef, triggerRef } from 'vue'
import type { RawBar } from './candles'

export interface ChartSeries {
  kind: 'candles' | 'equity'
  title: string
  bars?: RawBar[]
  curve?: Array<Record<string, unknown>>
  rebalanceCount?: number
  benchmarkLabel?: string
}

const LIMIT = 30

/**
 * Series live in memory only. Market cards are persisted through `secure-user-data`,
 * which rejects payloads over 4MB and would silently disable conversation storage,
 * so bars must never reach the stored card.
 */
const seriesByRequest = new Map<string, ChartSeries>()
export const chartSeriesVersion = shallowRef(0)

export function rememberChartSeries(requestId: string, series: ChartSeries | null): void {
  if (!requestId) return
  seriesByRequest.delete(requestId)
  if (series) {
    seriesByRequest.set(requestId, series)
    if (seriesByRequest.size > LIMIT) {
      const oldest = seriesByRequest.keys().next().value
      if (oldest) seriesByRequest.delete(oldest)
    }
  }
  triggerRef(chartSeriesVersion)
}

export function chartSeriesFor(requestId: string): ChartSeries | undefined {
  return seriesByRequest.get(requestId)
}

export function clearChartSeries(): void {
  seriesByRequest.clear()
  triggerRef(chartSeriesVersion)
}
