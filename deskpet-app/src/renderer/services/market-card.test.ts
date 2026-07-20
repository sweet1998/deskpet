import { describe, expect, it } from 'vitest'
import { marketCardFromResearch } from './market-card'

describe('marketCardFromResearch', () => {
  it('maps stock code, price and change percent', () => {
    const result = marketCardFromResearch({
      scope: 'in_scope',
      intent: 'security_quote',
      requiresResearch: false,
      targetKind: 'security',
      targets: [],
      thoughts: [],
      context: {
        kind: 'security',
        market: {
          source: 'akshare-eastmoney',
          asOf: '2026-07-20T10:00:00+08:00',
          securities: [{ code: 'SH.600519', name: '贵州茅台', price: 1488.2, changePercent: 1.25 }],
        },
      },
    })

    expect(result).toMatchObject({
      title: '个股行情',
      source: 'akshare-eastmoney',
      items: [{ code: '600519', name: '贵州茅台', price: 1488.2, changePercent: 1.25 }],
    })
  })

  it('maps market index snapshots', () => {
    const result = marketCardFromResearch({
      scope: 'in_scope',
      intent: 'market_snapshot',
      requiresResearch: false,
      targetKind: 'market',
      targets: [],
      thoughts: [],
      context: {
        kind: 'market',
        source: 'tencent-public',
        indices: [{ code: 'SH.000001', name: '上证指数', price: 3300.1, changePercent: -0.4 }],
      },
    })

    expect(result?.items[0]).toEqual({ code: '000001', name: '上证指数', price: 3300.1, changePercent: -0.4 })
  })

  it('does not create an empty quote card', () => {
    expect(marketCardFromResearch({
      scope: 'in_scope',
      intent: 'education',
      requiresResearch: false,
      targetKind: 'knowledge',
      targets: [],
      thoughts: [],
      context: { kind: 'knowledge' },
    })).toBeNull()
  })
})
