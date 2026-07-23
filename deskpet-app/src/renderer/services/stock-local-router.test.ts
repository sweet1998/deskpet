import { describe, expect, it } from 'vitest'
import { localStockPreparation, researchContextUnavailable } from './stock-local-router'

describe('stock local fallback router', () => {
  it.each(['什么是市盈率', 'MACD 怎么理解', '解释一下集合竞价', 'PE 和 PB 有什么区别'])(
    'recognizes education without depending on the research backend: %s',
    (query) => expect(localStockPreparation(query)?.intent).toBe('education'),
  )

  it('rejects clear out-of-scope queries but leaves mixed stock queries to the backend', () => {
    expect(localStockPreparation('今天天气怎么样')?.scope).toBe('out_of_scope')
    expect(localStockPreparation('天气变化会影响哪些股票')).toBeUndefined()
  })

  it('detects unavailable market contexts without treating education as unavailable', () => {
    expect(researchContextUnavailable({
      scope: 'in_scope', intent: 'market_snapshot', requiresResearch: false,
      targetKind: 'market', targets: [], thoughts: [], context: { kind: 'market', status: 'unavailable' },
    })).toBe(true)
    expect(researchContextUnavailable({
      scope: 'in_scope', intent: 'education', requiresResearch: false,
      targetKind: 'knowledge', targets: [], thoughts: [],
    })).toBe(false)
  })
})
