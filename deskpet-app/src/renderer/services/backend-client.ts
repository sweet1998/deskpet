import type { RoleId } from '../../shared/roles'
import type { MarketContextResult } from '../../shared/market'
import type { ResearchPrepareInput, ResearchPrepareResult } from '../../shared/research'

const BACKEND_URL_KEY = 'deskpet/backend-url'
const BACKEND_TOKEN_KEY = 'deskpet/backend-token'
const DEVICE_ID_KEY = 'deskpet/device-id'
const MARKET_SOURCE_KEY = 'deskpet/market-source'

export type MarketSource = 'backend' | 'opend'

export interface BackendChatInput {
  requestId: string
  roleId: RoleId
  text: string
  userName: string
  memories: string[]
  history: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface BackendEvent {
  event: string
  data: Record<string, any>
}

function storageGet(key: string, fallback = ''): string {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}

export function getBackendUrl(): string {
  return storageGet(BACKEND_URL_KEY, 'http://127.0.0.1:18540').replace(/\/$/, '')
}

export function setBackendUrl(value: string): void {
  localStorage.setItem(BACKEND_URL_KEY, value.trim().replace(/\/$/, ''))
}

export function getBackendToken(): string {
  return storageGet(BACKEND_TOKEN_KEY)
}

export function setBackendToken(value: string): void {
  localStorage.setItem(BACKEND_TOKEN_KEY, value.trim())
}

export function getDeviceId(): string {
  const existing = storageGet(DEVICE_ID_KEY)
  if (existing) return existing
  const created = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`
  localStorage.setItem(DEVICE_ID_KEY, created)
  return created
}

export function getMarketSource(): MarketSource {
  return storageGet(MARKET_SOURCE_KEY) === 'opend' ? 'opend' : 'backend'
}

export function setMarketSource(value: MarketSource): void {
  localStorage.setItem(MARKET_SOURCE_KEY, value)
}

function backendHeaders(): Record<string, string> {
  const token = getBackendToken()
  return {
    'Content-Type': 'application/json',
    'X-Device-Id': getDeviceId(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export async function getBackendMarketContext(query: string): Promise<MarketContextResult> {
  try {
    const response = await fetch(`${getBackendUrl()}/v1/market/context`, {
      method: 'POST',
      headers: backendHeaders(),
      body: JSON.stringify({ query, dailyCount: 120 }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as MarketContextResult
  } catch (error) {
    return {
      status: 'unavailable',
      source: 'deskpet-backend',
      error: error instanceof Error ? error.message : '行情后端不可用',
    }
  }
}

export async function prepareResearch(input: ResearchPrepareInput): Promise<ResearchPrepareResult> {
  const response = await fetch(`${getBackendUrl()}/v1/research/prepare`, {
    method: 'POST',
    headers: backendHeaders(),
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`研究准备失败（HTTP ${response.status}）`)
  return await response.json() as ResearchPrepareResult
}

export function parseSSEBlock(block: string): BackendEvent | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) data.push(line.slice(5).trim())
  }
  if (!data.length) return null
  try {
    return { event, data: JSON.parse(data.join('\n')) }
  } catch {
    return null
  }
}

export async function streamBackendChat(
  input: BackendChatInput,
  onEvent: (event: BackendEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${getBackendUrl()}/v1/agent/chat`, {
    method: 'POST',
    headers: backendHeaders(),
    body: JSON.stringify(input),
    signal,
  })
  if (!response.ok) throw new Error(`桌宠后端请求失败（HTTP ${response.status}）`)
  if (!response.body) throw new Error('桌宠后端没有返回流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const event = parseSSEBlock(block)
      if (event) onEvent(event)
    }
    if (done) break
  }
  const finalEvent = parseSSEBlock(buffer)
  if (finalEvent) onEvent(finalEvent)
}

export async function testBackendConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await fetch(`${getBackendUrl()}/health`)
    const data = await response.json() as { ok?: boolean; modelConfigured?: boolean }
    if (!response.ok || !data.ok) throw new Error(`HTTP ${response.status}`)
    return {
      ok: true,
      message: data.modelConfigured ? '后端和模型均已连接' : '后端可用，但尚未配置模型',
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '后端连接失败' }
  }
}
