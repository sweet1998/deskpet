import {
  DOUBAO_BASE_URL,
  type DoubaoCapabilityReport,
  type DoubaoMessage,
  type DoubaoResult,
} from '../shared/doubao'
import type {
  StockIntent,
  StockRouteDecision,
  StockRouteRequest,
  StockRouteResult,
} from '../shared/research'

export interface StoredDoubaoConfig {
  apiKey: string
  model: string
}

interface DoubaoApiResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>
  error?: { message?: string }
}

interface DoubaoStreamChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
}

interface DoubaoRequestOptions {
  signal?: AbortSignal
  maxTokens?: number
  fetchImpl?: typeof fetch
  baseUrl?: string
  onDelta?: (delta: string) => void
  temperature?: number
  jsonMode?: boolean
}

const DEFAULT_MAX_TOKENS = 4096
const MAX_CONVERSATION_MESSAGES = 24
const MAX_AUTO_CONTINUATIONS = 1
const CONTINUATION_PROMPT = '刚才的回答因长度限制中断。请从中断处直接续写，不要重复已经回答的内容，直到完整结束。'
const STOCK_ROUTE_SYSTEM_PROMPT = `你是 A 股桌面助手的请求路由器，只输出一个 JSON 对象，不回答用户问题。
字段固定为 scope、intent、relation、targetKind、targetTerms、requiresResearch、confidence。
scope 只能是 in_scope、needs_clarification、out_of_scope。
intent 只能是 security_quote、security_trend、fundamental、valuation、comparison、sector_snapshot、sector、sector_scan、index、market_snapshot、market、education、role_capability、answer_followup、clarification、out_of_scope。
relation 只能是 standalone、followup、answer_explanation、new_topic。
targetKind 只能是 security、sector、index、market、knowledge、none。
targetTerms 最多 3 个，只能逐字复制用户当前问题或历史消息中真实出现的股票、板块或指数名称，不得生成代码或改写名称。
只有需要组合行情、历史、财务等数据形成判断时 requiresResearch 才为 true；简单报价、知识解释、澄清、越界和解释上一条回答均为 false。
个股、A 股板块、指数、大盘和股票知识属于 in_scope；天气、编程、生活、基金、债券、期货、外汇、加密货币和海外股票属于 out_of_scope。
询问当前角色是谁、会什么、擅长什么或能提供哪些帮助时，返回 role_capability，属于 in_scope，不需要研究。
“为什么这么说”“依据是什么”“为什么没有覆盖消息面”等针对上一条回答的问题属于 answer_followup；结合最近历史识别“它”“那今天呢”等追问。明确表示换话题时 relation 为 new_topic。
“上涨的是哪几家”“领跌的是谁”“还有哪些”等省略标的的问题，如果历史正在讨论股票或板块，属于 in_scope 的 followup，必须继承历史目标，不能判为 out_of_scope。
confidence 是 0 到 1 的数字。信息不足且无法从历史继承时返回 needs_clarification。`

const STOCK_INTENTS = new Set<StockIntent>([
  'security_quote', 'security_trend', 'fundamental', 'valuation', 'comparison',
  'sector_snapshot', 'sector', 'sector_scan', 'index', 'market_snapshot', 'market',
  'education', 'role_capability', 'answer_followup', 'clarification', 'out_of_scope',
])
const STOCK_ROUTE_SCOPES = new Set(['in_scope', 'needs_clarification', 'out_of_scope'])
const STOCK_ROUTE_RELATIONS = new Set(['standalone', 'followup', 'answer_explanation', 'new_topic'])
const STOCK_ROUTE_TARGET_KINDS = new Set(['security', 'sector', 'index', 'market', 'knowledge', 'none'])

function limitedMessages(messages: DoubaoMessage[]): DoubaoMessage[] {
  if (messages.length <= MAX_CONVERSATION_MESSAGES) return messages
  if (messages[0]?.role === 'system') {
    return [messages[0], ...messages.slice(-(MAX_CONVERSATION_MESSAGES - 1))]
  }
  return messages.slice(-MAX_CONVERSATION_MESSAGES)
}

function compactRouteHistory(input: StockRouteRequest) {
  return input.history.slice(-6).map((message) => ({
    role: message.role,
    content: message.content.trim().slice(0, 1200),
  })).filter((message) => message.content)
}

function normalizeRouteText(value: string): string {
  return value.replace(/[\s，。！？、,.!?：:；;（）()\[\]【】"'“”‘’]+/g, '').toLocaleLowerCase()
}

export function parseStockRouteDecision(raw: string, input: StockRouteRequest): StockRouteDecision | undefined {
  try {
    const source = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const value = JSON.parse(source) as Record<string, unknown>
    if (!STOCK_ROUTE_SCOPES.has(String(value.scope))) return undefined
    if (!STOCK_INTENTS.has(String(value.intent) as StockIntent)) return undefined
    if (!STOCK_ROUTE_RELATIONS.has(String(value.relation))) return undefined
    if (!STOCK_ROUTE_TARGET_KINDS.has(String(value.targetKind))) return undefined
    const confidence = Number(value.confidence)
    if (!Number.isFinite(confidence)) return undefined

    const material = normalizeRouteText([
      input.text,
      ...input.history.flatMap((message) => message.content),
    ].join('\n'))
    const targetTerms = Array.isArray(value.targetTerms)
      ? [...new Set(value.targetTerms.flatMap((term) => {
        if (typeof term !== 'string') return []
        const trimmed = term.trim().slice(0, 60)
        const normalized = normalizeRouteText(trimmed)
        return trimmed && normalized && material.includes(normalized) ? [trimmed] : []
      }))].slice(0, 3)
      : []

    const scope = String(value.scope) as StockRouteDecision['scope']
    const relation = String(value.relation) as StockRouteDecision['relation']
    let intent = String(value.intent) as StockIntent
    let targetKind = String(value.targetKind) as StockRouteDecision['targetKind']
    let requiresResearch = value.requiresResearch === true
    if (scope === 'out_of_scope') {
      intent = 'out_of_scope'
      targetKind = 'none'
      requiresResearch = false
    } else if (scope === 'needs_clarification') {
      intent = 'clarification'
      targetKind = 'none'
      requiresResearch = false
    } else if (relation === 'answer_explanation' || intent === 'answer_followup') {
      intent = 'answer_followup'
      targetKind = 'knowledge'
      requiresResearch = false
    }
    return {
      scope,
      intent,
      relation,
      targetKind,
      targetTerms,
      requiresResearch,
      confidence: Math.max(0, Math.min(1, confidence)),
    }
  } catch {
    return undefined
  }
}

export async function classifyStockIntent(
  config: StoredDoubaoConfig,
  input: StockRouteRequest,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<StockRouteResult> {
  const routeInput = {
    text: input.text.trim().slice(0, 4000),
    history: compactRouteHistory(input),
  }
  const result = await requestDoubao(config, [
    { role: 'system', content: STOCK_ROUTE_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(routeInput) },
  ], {
    ...options,
    maxTokens: 350,
    temperature: 0,
    jsonMode: true,
  })
  if (!result.ok || !result.text) return { ok: false, error: result.error || '意图模型没有返回结果' }
  const decision = parseStockRouteDecision(result.text, input)
  return decision
    ? { ok: true, decision }
    : { ok: false, error: '意图模型返回了无效的结构化结果' }
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
  options: DoubaoRequestOptions = {},
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
        messages: limitedMessages(messages),
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
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
      const finishReason = body.choices?.[0]?.finish_reason || undefined
      return text
        ? {
            ok: true,
            text,
            ...(finishReason ? { finishReason } : {}),
            ...(finishReason === 'length' ? { truncated: true } : {}),
          }
        : { ok: false, error: '豆包没有返回文字内容' }
    }
    if (!response.body) return { ok: false, error: '豆包没有返回流式响应' }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''
    let finishReason = ''

    const consume = (block: string) => {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const chunk = JSON.parse(payload) as DoubaoStreamChunk
          const choice = chunk.choices?.[0]
          if (choice?.finish_reason) finishReason = choice.finish_reason
          const delta = choice?.delta?.content
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
      ? {
          ok: true,
          text,
          ...(finishReason ? { finishReason } : {}),
          ...(finishReason === 'length' ? { truncated: true } : {}),
        }
      : { ok: false, error: '豆包没有返回文字内容' }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: '请求已取消' }
    }
    if (error instanceof TypeError) return { ok: false, error: '无法连接豆包服务，请检查网络后重试' }
    return { ok: false, error: error instanceof Error ? error.message : '无法连接豆包服务' }
  }
}

export async function requestDoubaoConversation(
  config: StoredDoubaoConfig,
  messages: DoubaoMessage[],
  options: DoubaoRequestOptions = {},
): Promise<DoubaoResult> {
  let conversation = [...messages]
  let answer = ''

  for (let continuation = 0; continuation <= MAX_AUTO_CONTINUATIONS; continuation += 1) {
    const result = await requestDoubao(config, conversation, options)
    if (!result.ok || !result.text) return result
    answer += result.text
    if (!result.truncated) return { ...result, text: answer }
    if (continuation === MAX_AUTO_CONTINUATIONS) {
      return { ...result, text: answer, truncated: true }
    }
    conversation = [
      ...conversation,
      { role: 'assistant', content: result.text },
      { role: 'user', content: CONTINUATION_PROMPT },
    ]
  }

  return { ok: true, text: answer }
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
