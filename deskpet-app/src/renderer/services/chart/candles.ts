export const UP_COLOR = '#b85b65'
export const DOWN_COLOR = '#4f8a6d'
export const NEUTRAL_COLOR = '#8791a2'

export interface Candle {
  time: string
  open: number
  high: number
  low: number
  close: number
}

export interface LinePoint {
  time: string
  value: number
}

export interface RawBar {
  time?: unknown
  open?: unknown
  high?: unknown
  low?: unknown
  close?: unknown
  volume?: unknown
}

function normalizeTime(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`
  return null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * lightweight-charts throws on unsorted, duplicated or partial rows, which would
 * take the whole chat panel down with it.
 */
export function toCandles(bars: readonly RawBar[] | null | undefined, limit: number): Candle[] {
  if (!Array.isArray(bars)) return []
  const byTime = new Map<string, Candle>()

  for (const bar of bars) {
    if (!bar || typeof bar !== 'object') continue
    const time = normalizeTime(bar.time)
    if (!time) continue
    const open = finite(bar.open)
    const high = finite(bar.high)
    const low = finite(bar.low)
    const close = finite(bar.close)
    if (open === null || high === null || low === null || close === null) continue
    byTime.set(time, { time, open, high, low, close })
  }

  const rows = [...byTime.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  return limit > 0 ? rows.slice(-limit) : rows
}

export function toMovingAverage(candles: readonly Candle[], period: number): LinePoint[] {
  if (!Number.isInteger(period) || period <= 1 || candles.length < period) return []
  const points: LinePoint[] = []
  let sum = 0

  for (let index = 0; index < candles.length; index += 1) {
    sum += candles[index].close
    if (index >= period) sum -= candles[index - period].close
    if (index >= period - 1) {
      points.push({
        time: candles[index].time,
        value: Number((sum / period).toFixed(4)),
      })
    }
  }

  return points
}
