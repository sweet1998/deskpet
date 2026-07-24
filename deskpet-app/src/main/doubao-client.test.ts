import { describe, expect, it, vi } from 'vitest'
import {
  detectDoubaoCapabilities,
  normalizeDoubaoConfig,
  requestDoubao,
  requestDoubaoConversation,
} from './doubao-client'

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

  it('allows an explicit local base URL for offline integration tests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '本地响应' } }] }),
    })

    await requestDoubao(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '测试' }],
      { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'http://127.0.0.1:19000/v1/' },
    )

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:19000/v1/chat/completions',
      expect.any(Object),
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

  it.each([
    [401, 'API Key 无效'],
    [404, '没有找到这个 Endpoint'],
    [429, '额度不足'],
    [502, '服务暂时不可用'],
  ])('turns HTTP %i into an actionable setup error', async (status, expected) => {
    const result = await requestDoubao(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '你好' }],
      {
        fetchImpl: vi.fn().mockResolvedValue({
          ok: false,
          status,
          json: async () => { throw new Error('not json') },
        }) as unknown as typeof fetch,
      },
    )

    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain(expected)
  })

  it('turns network failures into a retryable message', async () => {
    const result = await requestDoubao(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '你好' }],
      { fetchImpl: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch },
    )

    expect(result.error).toBe('无法连接豆包服务，请检查网络后重试')
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

  it('marks a streamed answer as truncated when the provider reaches its token limit', async () => {
    const encoder = new TextEncoder()
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"回答到一半"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200 })

    const result = await requestDoubao(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '详细分析' }],
      { fetchImpl: vi.fn().mockResolvedValue(response) as unknown as typeof fetch, onDelta: vi.fn() },
    )

    expect(result).toEqual({
      ok: true,
      text: '回答到一半',
      finishReason: 'length',
      truncated: true,
    })
  })

  it('automatically continues a truncated streamed answer from the cutoff', async () => {
    const encoder = new TextEncoder()
    const streamResponse = (data: string) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(data))
        controller.close()
      },
    }), { status: 200 })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(streamResponse(
        'data: {"choices":[{"delta":{"content":"我不方便瞎"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
        + 'data: [DONE]\n\n',
      ))
      .mockResolvedValueOnce(streamResponse(
        'data: {"choices":[{"delta":{"content":"猜，仍需核实消息面。"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      ))
    const onDelta = vi.fn()

    const result = await requestDoubaoConversation(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'system', content: '保持严谨' }, { role: 'user', content: '分析医药板块' }],
      { fetchImpl: fetchImpl as unknown as typeof fetch, onDelta, maxTokens: 4096 },
    )

    expect(result).toMatchObject({ ok: true, text: '我不方便瞎猜，仍需核实消息面。' })
    expect(result.truncated).toBeUndefined()
    expect(onDelta.mock.calls.map(([delta]) => delta).join('')).toBe(result.text)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(String(fetchImpl.mock.calls[0][1].body))
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1][1].body))
    expect(firstBody.max_tokens).toBe(4096)
    expect(secondBody.messages.at(-2)).toEqual({ role: 'assistant', content: '我不方便瞎' })
    expect(secondBody.messages.at(-1).content).toContain('从中断处直接续写')
  })

  it('keeps image content blocks for screen understanding', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '截图里是代码编辑器' } }] }),
    })

    await requestDoubao(
      { apiKey: 'secret', model: 'ep-vision' },
      [{
        role: 'user',
        content: [
          { type: 'text', text: '分析截图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'high' } },
        ],
      }],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    const request = fetchImpl.mock.calls[0][1] as RequestInit
    const body = JSON.parse(String(request.body))
    expect(body.messages[0].content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc', detail: 'high' },
    })
  })

  it('detects text, streaming, and vision capabilities independently', async () => {
    const encoder = new TextEncoder()
    const stream = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"流式正常"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }), { status: 200 })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(stream)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'model does not support image input' } }),
      })

    const report = await detectDoubaoCapabilities(
      { apiKey: 'secret', model: 'ep-text' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 123 },
    )

    expect(report).toMatchObject({
      model: 'ep-text', checkedAt: 123, text: true, streaming: true, vision: false,
    })
    expect(report.errors.vision).toContain('image input')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('stops capability detection when the text connection fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'invalid api key' } }),
    })

    const report = await detectDoubaoCapabilities(
      { apiKey: 'bad', model: 'ep-test' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(report.text).toBe(false)
    expect(report.streaming).toBe(false)
    expect(report.vision).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
