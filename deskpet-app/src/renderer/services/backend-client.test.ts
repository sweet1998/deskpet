import { describe, expect, it } from 'vitest'
import { getMarketSource, parseSSEBlock } from './backend-client'

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
})
