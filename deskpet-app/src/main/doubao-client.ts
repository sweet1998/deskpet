import {
  DOUBAO_BASE_URL,
  type DoubaoCapabilityReport,
  type DoubaoMessage,
  type DoubaoResult,
} from '../shared/doubao'

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

function doubaoHttpError(status: number, detail = ''): string {
  if (status === 401 || status === 403) return '豆包 API Key 无效或没有访问权限，请检查后重试'
  if (status === 404) return '没有找到这个 Endpoint，请检查模型 / Endpoint ID'
  if (status === 429) return '豆包请求过于频繁或账户额度不足，请稍后重试并检查火山方舟额度'
  if (status >= 500) return '豆包服务暂时不可用，请稍后重试'
  if (status === 400) return detail
    ? `豆包不接受当前配置：${detail.slice(0, 160)}`
    : '豆包不接受当前配置，请检查 Endpoint ID'
  return detail ? `豆包请求失败：${detail.slice(0, 160)}` : `豆包请求失败（HTTP ${status}）`
}

const VISION_TEST_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Y4sAAAAASUVORK5CYII='

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
    baseUrl?: string
    onDelta?: (delta: string) => void
    temperature?: number
    jsonMode?: boolean
  } = {},
): Promise<DoubaoResult> {
  if (!config.apiKey) return { ok: false, error: '请先在设置中填写豆包 API Key' }
  if (!config.model) return { ok: false, error: '请先填写豆包 Endpoint ID 或模型名称' }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: '对话内容不能为空' }
  }

  try {
    const streaming = typeof options.onDelta === 'function'
    const baseUrl = (options.baseUrl || DOUBAO_BASE_URL).replace(/\/+$/, '')
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: messages.slice(-20),
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 1200,
        stream: streaming,
        ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: options.signal,
    })
    if (!response.ok) {
      let body: DoubaoApiResponse = {}
      try { body = await response.json() as DoubaoApiResponse } catch { /* provider may return HTML */ }
      return { ok: false, error: doubaoHttpError(response.status, body.error?.message) }
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
    if (error instanceof TypeError) return { ok: false, error: '无法连接豆包服务，请检查网络后重试' }
    return { ok: false, error: error instanceof Error ? error.message : '无法连接豆包服务' }
  }
}

export async function detectDoubaoCapabilities(
  config: StoredDoubaoConfig,
  options: { fetchImpl?: typeof fetch; baseUrl?: string; now?: () => number } = {},
): Promise<DoubaoCapabilityReport> {
  const report: DoubaoCapabilityReport = {
    model: config.model,
    checkedAt: (options.now ?? Date.now)(),
    text: false,
    streaming: false,
    vision: false,
    errors: {},
  }
  const common = { fetchImpl: options.fetchImpl, baseUrl: options.baseUrl, maxTokens: 16 }
  let receivedDelta = false
  const streaming = await requestDoubao(
    config,
    [{ role: 'user', content: '只回复“流式正常”四个字。' }],
    { ...common, onDelta: () => { receivedDelta = true } },
  )
  report.text = streaming.ok
  report.streaming = streaming.ok && receivedDelta
  if (!report.text) report.errors.text = streaming.error || '文字对话检测失败'
  if (!report.streaming) {
    report.errors.streaming = streaming.error || '模型没有返回流式内容'
  }
  if (!report.text) {
    report.errors.vision = '文字连接未通过，未检测视觉输入'
    return report
  }

  const vision = await requestDoubao(
    config,
    [{
      role: 'user',
      content: [
        { type: 'text', text: '这是一张能力检测图片，只回复“图片可用”。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${VISION_TEST_IMAGE}`, detail: 'low' } },
      ],
    }],
    common,
  )
  report.vision = vision.ok
  if (!vision.ok) report.errors.vision = vision.error || '视觉输入检测失败'
  return report
}
