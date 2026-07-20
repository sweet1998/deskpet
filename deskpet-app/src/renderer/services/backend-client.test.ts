import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMarketSource, parseSSEBlock, streamResearchPreparation } from './backend-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('backend SSE parser', () => {
  it('uses the install-free backend market source by default', () => {
    localStorage.clear()
    expect(getMarketSource()).toBe('backend')
  })

  it('parses named events and JSON data', () => {
    expect(parseSSEBlock('event: delta\ndata: {"text":"你好"}')).toEqual({
      event: 'delta',
      data: { text: '你好' },
    })
  })

  it('ignores malformed event payloads', () => {
    expect(parseSSEBlock('event: delta\ndata: not-json')).toBeNull()
  })

  it('delivers research reasoning before the prepared result', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode('event: reasoning\ndata: {"text":"已获取行业快照"}\n\n'),
      encoder.encode('event: reasoning\ndata: {"text":"已完成趋势计算"}\n\n'),
      encoder.encode('event: result\ndata: {"scope":"in_scope","intent":"sector_scan","requiresResearch":true,"targetKind":"sector","targets":[],"thoughts":[]}\n\n'),
    ]
    let index = 0
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => index < chunks.length
            ? { value: chunks[index++], done: false }
            : { value: undefined, done: true },
        }),
      },
    }))
    const reasoning: string[] = []

    const result = await streamResearchPreparation({
      text: '最近什么行情有上涨趋势',
      roleId: 'stock_expert',
      history: [],
    }, async (text) => {
      await Promise.resolve()
      reasoning.push(text)
    })

    expect(reasoning).toEqual(['已获取行业快照', '已完成趋势计算'])
    expect(result.intent).toBe('sector_scan')
  })
})
