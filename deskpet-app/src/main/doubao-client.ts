import { DOUBAO_BASE_URL, type DoubaoMessage, type DoubaoResult } from '../shared/doubao'

export interface StoredDoubaoConfig {
  apiKey: string
  model: string
}

interface DoubaoApiResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}

interface DoubaoStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>
}

export function normalizeDoubaoConfig(
  input: unknown,
  current: StoredDoubaoConfig = { apiKey: '', model: '' },
): StoredDoubaoConfig {
  if (!input || typeof input !== 'object') return current
  const value = input as { apiKey?: unknown; model?: unknown }
  const apiKey = typeof value.apiKey === 'string' && value.apiKey.trim()
    ? value.apiKey.trim().slice(0, 512)
    : current.apiKey
  const model = typeof value.model === 'string'
    ? value.model.trim().slice(0, 200)
    : current.model
  return { apiKey, model }
}

export async function requestDoubao(
  config: StoredDoubaoConfig,
  messages: DoubaoMessage[],
  options: {
    signal?: AbortSignal
    maxTokens?: number
    fetchImpl?: typeof fetch
    onDelta?: (delta: string) => void
  } = {},
): Promise<DoubaoResult> {
  if (!config.apiKey) return { ok: false, error: '请先在设置中填写豆包 API Key' }
  if (!config.model) return { ok: false, error: '请先填写豆包 Endpoint ID 或模型名称' }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: '对话内容不能为空' }
  }

  try {
    const streaming = typeof options.onDelta === 'function'
    const response = await (options.fetchImpl ?? fetch)(`${DOUBAO_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: messages.slice(-20),
        temperature: 0.7,
        max_tokens: options.maxTokens ?? 1200,
        stream: streaming,
      }),
      signal: options.signal,
    })
    if (!response.ok) {
      const body = await response.json() as DoubaoApiResponse
      return { ok: false, error: body.error?.message || `豆包请求失败（HTTP ${response.status}）` }
    }
    if (!streaming) {
      const body = await response.json() as DoubaoApiResponse
      const text = body.choices?.[0]?.message?.content?.trim()
      return text
        ? { ok: true, text }
        : { ok: false, error: '豆包没有返回文字内容' }
    }
    if (!response.body) return { ok: false, error: '豆包没有返回流式响应' }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''

    const consume = (block: string) => {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const chunk = JSON.parse(payload) as DoubaoStreamChunk
          const delta = chunk.choices?.[0]?.delta?.content
          if (!delta) continue
          answer += delta
          options.onDelta?.(delta)
        } catch { /* ignore malformed SSE chunks */ }
      }
    }

    while (true) {
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() || ''
      blocks.forEach(consume)
      if (done) break
    }
    if (buffer.trim()) consume(buffer)
    const text = answer.trim()
    return text
      ? { ok: true, text }
      : { ok: false, error: '豆包没有返回文字内容' }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: '请求已取消' }
    }
    return { ok: false, error: error instanceof Error ? error.message : '无法连接豆包服务' }
  }
}
