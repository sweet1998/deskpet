export const DOUBAO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

export type AiProvider = 'doubao' | 'maibot' | 'backend'

export interface DoubaoConfigInput {
  apiKey?: string
  model?: string
}

export interface DoubaoConfigView {
  baseUrl: string
  model: string
  hasApiKey: boolean
  capabilities?: DoubaoCapabilityReport
}

export interface DoubaoCapabilityReport {
  model: string
  checkedAt: number
  text: boolean
  streaming: boolean
  vision: boolean
  errors: Partial<Record<'text' | 'streaming' | 'vision', string>>
}

export type DoubaoContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }

export interface DoubaoMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | DoubaoContentPart[]
}

export interface DoubaoChatRequest {
  requestId: string
  messages: DoubaoMessage[]
  maxTokens?: number
}

export interface DoubaoStreamDelta {
  requestId: string
  delta: string
}

export interface DoubaoResult {
  ok: boolean
  text?: string
  error?: string
  truncated?: boolean
  finishReason?: string
}
