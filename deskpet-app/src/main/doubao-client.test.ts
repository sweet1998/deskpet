import { describe, expect, it, vi } from 'vitest'
import {
  DESKPET_COMPLETION_MARKER,
  classifyStockIntent,
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

  it('forwards the thinking directive so reasoning models stop eating the output budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '完整回答' } }] }),
    })

    await requestDoubao(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '明天可以炒股吗' }],
      { fetchImpl: fetchImpl as unknown as typeof fetch, thinking: 'disabled' },
    )

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body))
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('retries without the thinking directive when the model rejects it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'thinking is not supported' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '兜底回答' } }] }),
      })

    const result = await requestDoubao(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '你好' }],
      { fetchImpl: fetchImpl as unknown as typeof fetch, thinking: 'disabled' },
    )

    expect(result).toEqual({ ok: true, text: '兜底回答' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body)).thinking).toEqual({ type: 'disabled' })
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1].body))).not.toHaveProperty('thinking')
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

  it('classifies an ambiguous follow-up with deterministic JSON settings', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        scope: 'in_scope',
        intent: 'sector',
        relation: 'followup',
        targetKind: 'sector',
        targetTerms: ['白酒', '新能源'],
        requiresResearch: true,
        confidence: 0.96,
      }) } }] }),
    })
    const input = {
      requestId: 'route-1',
      text: '它最近怎么样',
      history: [
        { role: 'user' as const, content: '看看白酒板块' },
        { role: 'assistant' as const, content: '白酒板块近期震荡。' },
      ],
    }

    const result = await classifyStockIntent(
      { apiKey: 'secret', model: 'ep-test' },
      input,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(result).toMatchObject({
      ok: true,
      decision: { intent: 'sector', relation: 'followup', targetTerms: ['白酒'], confidence: 0.96 },
    })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body))
    expect(body).toMatchObject({
      temperature: 0,
      max_tokens: 350,
      stream: false,
      response_format: { type: 'json_object' },
    })
  })

  it('rejects malformed stock routing output', async () => {
    const result = await classifyStockIntent(
      { apiKey: 'secret', model: 'ep-test' },
      { requestId: 'route-bad', text: '它怎么样', history: [] },
      {
        fetchImpl: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '{"intent":"sector"}' } }] }),
        }) as unknown as typeof fetch,
      },
    )

    expect(result).toMatchObject({ ok: false, error: '意图模型返回了无效的结构化结果' })
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

  it('marks a partial stream as truncated when the connection closes without DONE', async () => {
    const encoder = new TextEncoder()
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"市场风格偏"}}]}\n\n'))
        controller.close()
      },
    }), { status: 200 })

    const result = await requestDoubao(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '今天行情怎么样' }],
      { fetchImpl: vi.fn().mockResolvedValue(response) as unknown as typeof fetch, onDelta: vi.fn() },
    )

    expect(result).toMatchObject({
      ok: true,
      text: '市场风格偏',
      finishReason: 'connection_closed',
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
        `data: {"choices":[{"delta":{"content":"猜，仍需核实消息面。${DESKPET_COMPLETION_MARKER}"}}]}\n\n`
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      ))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"complete":true}' } }] }),
      })
    const onDelta = vi.fn()

    const result = await requestDoubaoConversation(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'system', content: '保持严谨' }, { role: 'user', content: '分析医药板块' }],
      { fetchImpl: fetchImpl as unknown as typeof fetch, onDelta, maxTokens: 4096 },
    )

    expect(result).toMatchObject({ ok: true, text: '我不方便瞎猜，仍需核实消息面。' })
    expect(result.truncated).toBeUndefined()
    expect(onDelta.mock.calls.map(([delta]) => delta).join('')).toBe(result.text)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    const firstBody = JSON.parse(String(fetchImpl.mock.calls[0][1].body))
    const secondBody = JSON.parse(String(fetchImpl.mock.calls[1][1].body))
    expect(firstBody.max_tokens).toBe(4096)
    expect(secondBody.messages.at(-2)).toEqual({ role: 'assistant', content: '我不方便瞎' })
    expect(secondBody.messages.at(-1).content).toContain('从断点直接续写')
    expect(JSON.stringify(firstBody.messages)).toContain(DESKPET_COMPLETION_MARKER)
    expect(onDelta.mock.calls.map(([delta]) => delta).join('')).not.toContain(DESKPET_COMPLETION_MARKER)
  })

  it('continues when the model puts the completion marker after an unfinished sentence', async () => {
    const encoder = new TextEncoder()
    const streamResponse = (data: string) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(data))
        controller.close()
      },
    }), { status: 200 })
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(streamResponse(
        `data: {"choices":[{"delta":{"content":"市场风格偏${DESKPET_COMPLETION_MARKER}"}}]}\n\n`
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      ))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"complete":false}' } }] }),
      })
      .mockResolvedValueOnce(streamResponse(
        `data: {"choices":[{"delta":{"content":"成长。${DESKPET_COMPLETION_MARKER}"}}]}\n\n`
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      ))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"complete":true}' } }] }),
      })
    const onDelta = vi.fn()

    const result = await requestDoubaoConversation(
      { apiKey: 'secret', model: 'ep-test' },
      [{ role: 'user', content: '今天行情怎么样' }],
      { fetchImpl: fetchImpl as unknown as typeof fetch, onDelta },
    )

    expect(result).toMatchObject({ ok: true, text: '市场风格偏成长。' })
    expect(result.truncated).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(onDelta.mock.calls.map(([delta]) => delta).join('')).toBe('市场风格偏成长。')
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
