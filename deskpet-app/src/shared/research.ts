import type { RoleId } from './roles'

export type StockIntent =
  | 'security_quote'
  | 'security_trend'
  | 'fundamental'
  | 'valuation'
  | 'comparison'
  | 'sector'
  | 'index'
  | 'market'
  | 'education'
  | 'clarification'
  | 'out_of_scope'

export interface ResearchHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ResearchTarget {
  kind: 'security' | 'sector' | 'index' | 'market' | 'knowledge'
  name: string
  code?: string
}

export interface ResearchPrepareInput {
  text: string
  roleId: RoleId
  history: ResearchHistoryMessage[]
}

export interface ResearchPrepareResult {
  scope: 'in_scope' | 'needs_clarification' | 'out_of_scope'
  intent: StockIntent
  requiresResearch: boolean
  targetKind: 'security' | 'sector' | 'index' | 'market' | 'knowledge' | 'none'
  targets: ResearchTarget[]
  thoughts: string[]
  context?: Record<string, any>
  reply?: string
}
