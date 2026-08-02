import { describe, expect, it } from 'vitest'
import { compactPromptContext, compactResearchContext } from './research'

const securityContext = () => ({
  kind: 'security',
  market: {
    securities: [{
      name: '贵州茅台',
      dailyBars: [
        { time: '2026-07-16', open: 1480, high: 1495, low: 1475, close: 1490, volume: 1200, amount: 9 },
        { time: '2026-07-17', open: 1490, high: 1510, low: 1488, close: 1500, volume: 1500, amount: 9 },
      ],
      technical: { return20d: 3.2 },
    }],
  },
})

describe('research context compaction', () => {
  it('keeps chart-ready bars alongside the sample range for the UI', () => {
    const security = compactResearchContext(securityContext()).market.securities[0]

    expect(security).toMatchObject({
      history: { points: 2, from: '2026-07-16', to: '2026-07-17' },
      technical: { return20d: 3.2 },
    })
    expect(security.dailyBars).toEqual([
      { time: '2026-07-16', open: 1480, high: 1495, low: 1475, close: 1490, volume: 1200 },
      { time: '2026-07-17', open: 1490, high: 1510, low: 1488, close: 1500, volume: 1500 },
    ])
  })

  it('keeps only the last 60 bars', () => {
    const bars = Array.from({ length: 250 }, (_, index) => ({
      time: `bar-${index}`, open: 1, high: 2, low: 0, close: 1, volume: 1,
    }))
    const security = compactResearchContext({
      kind: 'security',
      market: { securities: [{ name: '贵州茅台', dailyBars: bars }] },
    }).market.securities[0]

    expect(security.dailyBars).toHaveLength(60)
    expect(security.dailyBars.at(-1).time).toBe('bar-249')
    expect(security.history.points).toBe(250)
  })

  it('replaces raw K-lines with their sample range for model prompts', () => {
    const context = compactPromptContext(securityContext())

    expect(JSON.stringify(context)).not.toContain('dailyBars')
    expect(context.market.securities[0]).toMatchObject({
      history: { points: 2, from: '2026-07-16', to: '2026-07-17' },
      technical: { return20d: 3.2 },
    })
  })

  it('does not recount history when compacting an already stored context', () => {
    const bars = Array.from({ length: 250 }, (_, index) => ({
      time: `bar-${index}`, open: 1, high: 2, low: 0, close: 1, volume: 1,
    }))
    const stored = compactResearchContext({
      kind: 'security',
      market: { securities: [{ name: '贵州茅台', dailyBars: bars }] },
    })
    const prompt = compactPromptContext(stored)

    expect(JSON.stringify(prompt)).not.toContain('dailyBars')
    expect(prompt.market.securities[0].history.points).toBe(250)
  })

  it('truncates long lists but keeps the full backtest curve', () => {
    const context = compactResearchContext({
      kind: 'strategy_backtest',
      result: {
        curve: Array.from({ length: 50 }, (_, index) => ({ date: `d${index}`, equity: 1 })),
        rebalances: Array.from({ length: 50 }, (_, index) => ({ index })),
      },
    })

    expect(context.result.curve).toHaveLength(50)
    expect(context.result.rebalances).toHaveLength(20)
  })
})
