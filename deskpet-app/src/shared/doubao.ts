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
}

export interface DoubaoMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface DoubaoChatRequest {
  requestId: string
  messages: DoubaoMessage[]
}

export interface DoubaoStreamDelta {
  requestId: string
  delta: string
}

export interface DoubaoResult {
  ok: boolean
  text?: string
  error?: string
}
