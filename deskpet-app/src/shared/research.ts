import type { RoleId } from './roles'

export type StockIntent =
  | 'security_quote'
  | 'security_trend'
  | 'fundamental'
  | 'valuation'
  | 'comparison'
  | 'sector_snapshot'
  | 'sector'
  | 'sector_scan'
  | 'index'
  | 'market_snapshot'
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

export function compactResearchContext(context: Record<string, any>): Record<string, any> {
  function compact(value: any): any {
    if (Array.isArray(value)) return value.slice(0, 20).map(compact)
    if (!value || typeof value !== 'object') return value

    const output: Record<string, any> = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'dailyBars' && Array.isArray(child)) {
        const rows = child.filter((item) => item && typeof item === 'object')
        output.history = {
          points: rows.length,
          ...(rows.length ? { from: rows[0].time, to: rows.at(-1).time } : {}),
        }
      } else if (key === 'warnings' && Array.isArray(child)) {
        output[key] = child.slice(0, 5).map((warning) => String(warning).slice(0, 180))
      } else {
        output[key] = compact(child)
      }
    }
    return output
  }

  return compact(context)
}
