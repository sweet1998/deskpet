import { describe, expect, it } from 'vitest'
import { compactResearchContext } from './research'

describe('research context compaction', () => {
  it('replaces raw K-lines with their sample range', () => {
    const context = compactResearchContext({
      kind: 'security',
      market: {
        securities: [{
          name: '贵州茅台',
          dailyBars: [
            { time: '2026-07-16', close: 1490 },
            { time: '2026-07-17', close: 1500 },
          ],
          technical: { return20d: 3.2 },
        }],
      },
    })

    expect(JSON.stringify(context)).not.toContain('dailyBars')
    expect(context.market.securities[0]).toMatchObject({
      history: { points: 2, from: '2026-07-16', to: '2026-07-17' },
      technical: { return20d: 3.2 },
    })
  })
})
