import { describe, expect, it, vi } from 'vitest'
import { normalizeDoubaoConfig, requestDoubao } from './doubao-client'

describe('doubao client', () => {
  it('keeps an existing key when the settings form submits an empty key', () => {
    expect(normalizeDoubaoConfig(
      { apiKey: '', model: 'ep-new' },
      { apiKey: 'saved-key', model: 'ep-old' },
    )).toEqual({ apiKey: 'saved-key', model: 'ep-new' })
  })

  it('sends an Ark chat completion request and extracts the answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '你好呀' } }] }),
    })
    const result = await requestDoubao(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '你好' }],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(result).toEqual({ ok: true, text: '你好呀' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
      }),
    )
  })

  it('reports missing credentials without making a request', async () => {
    const fetchImpl = vi.fn()
    const result = await requestDoubao(
      { apiKey: '', model: 'ep-test' },
      [{ role: 'user', content: '你好' }],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(result.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('streams Ark SSE deltas as they arrive', async () => {
    const encoder = new TextEncoder()
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"贵州"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"茅台"}}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    const fetchImpl = vi.fn().mockResolvedValue(response)
    const onDelta = vi.fn()

    const result = await requestDoubao(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '分析茅台' }],
      { fetchImpl: fetchImpl as unknown as typeof fetch, onDelta },
    )

    expect(result).toEqual({ ok: true, text: '贵州茅台' })
    expect(onDelta.mock.calls.map(([delta]) => delta)).toEqual(['贵州', '茅台'])
    const request = fetchImpl.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({ stream: true })
  })
})
