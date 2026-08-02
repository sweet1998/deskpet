import { describe, expect, it } from 'vitest'
import { DOWN_COLOR, NEUTRAL_COLOR, UP_COLOR, toCandles, toMovingAverage } from './candles'
import { barColor, volumeBars } from './volume'
import { curveIsPartial, toEquityCurve } from './equity-curve'
import { chartLayout } from './preview-metrics'

const bar = (time: string, close: number, open = close) => ({
  time, open, high: close + 1, low: close - 1, close, volume: 100,
})

describe('toCandles', () => {
  it('returns nothing for missing or malformed input', () => {
    expect(toCandles(undefined, 60)).toEqual([])
    expect(toCandles(null, 60)).toEqual([])
    expect(toCandles([null as any, 'x' as any, {}], 60)).toEqual([])
  })

  it('drops rows with a null price, which the chart library rejects', () => {
    const rows = toCandles([
      { time: '2026-07-16', open: 10, high: 11, low: 9, close: null },
      { time: '2026-07-17', open: null, high: 11, low: 9, close: 10 },
      bar('2026-07-18', 12),
    ], 60)

    expect(rows).toHaveLength(1)
    expect(rows[0].time).toBe('2026-07-18')
  })

  it('drops rows with an empty or malformed time', () => {
    expect(toCandles([
      { time: '', open: 1, high: 2, low: 0, close: 1 },
      { time: '   ', open: 1, high: 2, low: 0, close: 1 },
      { time: 20260718 as any, open: 1, high: 2, low: 0, close: 1 },
    ], 60)).toEqual([])
  })

  it('normalizes YYYYMMDD to an ISO date', () => {
    expect(toCandles([bar('20260718', 12)], 60)[0].time).toBe('2026-07-18')
  })

  it('sorts ascending and de-duplicates, keeping the last row for a date', () => {
    const rows = toCandles([bar('2026-07-18', 12), bar('2026-07-16', 10), bar('2026-07-18', 99)], 60)

    expect(rows.map((row) => row.time)).toEqual(['2026-07-16', '2026-07-18'])
    expect(rows[1].close).toBe(99)
  })

  it('keeps the most recent bars up to the limit', () => {
    const rows = toCandles(
      Array.from({ length: 250 }, (_, index) => bar(`2026-01-${String((index % 28) + 1).padStart(2, '0')}`, index)),
      60,
    )

    expect(rows.length).toBeLessThanOrEqual(60)
    expect(rows.at(-1)!.time).toBe('2026-01-28')
  })
})

describe('toMovingAverage', () => {
  it('starts each average only after enough bars are available', () => {
    const rows = toMovingAverage([
      bar('2026-07-16', 10),
      bar('2026-07-17', 20),
      bar('2026-07-18', 30),
      bar('2026-07-19', 40),
      bar('2026-07-20', 50),
    ], 3)

    expect(rows).toEqual([
      { time: '2026-07-18', value: 20 },
      { time: '2026-07-19', value: 30 },
      { time: '2026-07-20', value: 40 },
    ])
  })

  it('returns nothing when the period is invalid or the series is too short', () => {
    expect(toMovingAverage([bar('2026-07-16', 10)], 1)).toEqual([])
    expect(toMovingAverage([bar('2026-07-16', 10), bar('2026-07-17', 20)], 5)).toEqual([])
  })
})

describe('barColor', () => {
  it('uses red for gains and green for losses, per A-share convention', () => {
    expect(barColor({ open: 10, close: 11 })).toBe(UP_COLOR)
    expect(barColor({ open: 11, close: 10 })).toBe(DOWN_COLOR)
    expect(barColor({ open: 10, close: 10 })).toBe(NEUTRAL_COLOR)
  })

  it('pins the exact palette so the western convention cannot creep back in', () => {
    expect(UP_COLOR).toBe('#b85b65')
    expect(DOWN_COLOR).toBe('#4f8a6d')
  })
})

describe('volumeBars', () => {
  it('colours each bar by its own session direction', () => {
    const rows = volumeBars([
      { time: '2026-07-16', open: 10, high: 12, low: 9, close: 11, volume: 500 },
      { time: '2026-07-17', open: 11, high: 12, low: 9, close: 10, volume: 700 },
    ], 60)

    expect(rows).toEqual([
      { time: '2026-07-16', value: 500, color: UP_COLOR },
      { time: '2026-07-17', value: 700, color: DOWN_COLOR },
    ])
  })

  it('skips bars without a usable volume', () => {
    expect(volumeBars([{ time: '2026-07-16', open: 10, high: 12, low: 9, close: 11, volume: null }], 60)).toEqual([])
  })
})

describe('toEquityCurve', () => {
  it('splits the curve into strategy and benchmark series', () => {
    const curve = toEquityCurve([
      { date: '2026-01-31', equity: 1.02, benchmark: 1.01 },
      { date: '2026-02-28', equity: 1.05, benchmark: 1.03 },
    ])

    expect(curve.equity).toEqual([
      { time: '2026-01-31', value: 1.02 },
      { time: '2026-02-28', value: 1.05 },
    ])
    expect(curve.benchmark).toHaveLength(2)
  })

  it('sorts by date and ignores unusable points', () => {
    const curve = toEquityCurve([
      { date: '2026-02-28', equity: 1.05 },
      { date: '2026-01-31', equity: 1.02 },
      { date: '2026-03-31', equity: null },
      { date: '', equity: 1.1 },
    ] as any)

    expect(curve.equity.map((point) => point.time)).toEqual(['2026-01-31', '2026-02-28'])
    expect(curve.benchmark).toEqual([])
  })

  it('returns empty series for missing input', () => {
    expect(toEquityCurve(undefined)).toEqual({ equity: [], benchmark: [] })
  })
})

describe('curveIsPartial', () => {
  it('flags a curve that has fewer points than the reported rebalances', () => {
    expect(curveIsPartial(20, 34)).toBe(true)
  })

  it('does not flag a complete curve', () => {
    expect(curveIsPartial(18, 18)).toBe(false)
    expect(curveIsPartial(0, 18)).toBe(false)
    expect(curveIsPartial(20, undefined)).toBe(false)
  })
})

describe('chartLayout', () => {
  it('drops axes and volume for the inline preview', () => {
    expect(chartLayout(260, false)).toMatchObject({ showAxes: false, showVolume: false })
  })

  it('keeps the bar count within the inline range even when very narrow', () => {
    expect(chartLayout(120, false).barLimit).toBe(30)
    expect(chartLayout(900, false).barLimit).toBe(40)
  })

  it('shows the full chart when expanded', () => {
    expect(chartLayout(720, true)).toEqual({ barLimit: 60, showAxes: true, showVolume: true })
  })
})
