import { describe, expect, it } from 'vitest'
import { researchContextUnavailable } from './stock-local-router'

describe('stock research context guard', () => {
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
