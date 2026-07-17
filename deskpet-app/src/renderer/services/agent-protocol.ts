export type AgentState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'planning'
  | 'executing'
  | 'awaiting_confirmation'
  | 'speaking'
  | 'success'
  | 'error'
  | 'interrupted'

export interface AgentStateEvent {
  requestId: string
  state: AgentState
  progress?: number
  step?: string
  interruptible?: boolean
  error?: string
}

export interface AgentTaskResult {
  requestId: string
  kind: 'text' | 'file-summary' | 'screen-analysis'
  title: string
  content: string
  actions?: string[]
}

export interface AgentConfirmation {
  requestId: string
  tool: string
  summary: string
  risk: 'low' | 'medium' | 'high'
  expiresAt?: number
}

export interface AgentFileInput {
  requestId: string
  name: string
  mimeType: string
  size: number
  base64: string
  prompt: string
}

const AGENT_STATES = new Set<AgentState>([
  'idle',
  'listening',
  'thinking',
  'planning',
  'executing',
  'awaiting_confirmation',
  'speaking',
  'success',
  'error',
  'interrupted',
])

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && AGENT_STATES.has(value as AgentState)
}

