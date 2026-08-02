import { DOWN_COLOR, NEUTRAL_COLOR, UP_COLOR, type Candle, type RawBar, toCandles } from './candles'

export interface VolumeBar {
  time: string
  value: number
  color: string
}

/** A-share convention: rising sessions are red, falling sessions are green. */
export function barColor(candle: Pick<Candle, 'open' | 'close'>): string {
  if (candle.close > candle.open) return UP_COLOR
  if (candle.close < candle.open) return DOWN_COLOR
  return NEUTRAL_COLOR
}

export function volumeBars(bars: readonly RawBar[] | null | undefined, limit: number): VolumeBar[] {
  if (!Array.isArray(bars)) return []
  const volumeByTime = new Map<string, number>()
  for (const bar of bars) {
    if (!bar || typeof bar !== 'object') continue
    const time = typeof bar.time === 'string' ? bar.time.trim() : ''
    const value = bar.volume
    if (time && typeof value === 'number' && Number.isFinite(value)) {
      volumeByTime.set(time.length === 8 ? `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6)}` : time, value)
    }
  }

  return toCandles(bars, limit).flatMap((candle) => {
    const value = volumeByTime.get(candle.time)
    return value === undefined ? [] : [{ time: candle.time, value, color: barColor(candle) }]
  })
}
