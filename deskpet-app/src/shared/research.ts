import type { RoleId } from './roles'

export type StockIntent =
  | 'security_quote'
  | 'security_trend'
  | 'security_news'
  | 'fundamental'
  | 'valuation'
  | 'comparison'
  | 'stock_screen'
  | 'strategy_backtest'
  | 'decision'
  | 'sector_snapshot'
  | 'sector'
  | 'sector_scan'
  | 'index'
  | 'market_snapshot'
  | 'market'
  | 'education'
  | 'role_capability'
  | 'answer_followup'
  | 'clarification'
  | 'out_of_scope'

export type StockRouteRelation = 'standalone' | 'followup' | 'answer_explanation' | 'new_topic'
export type StockRouteTargetKind = 'security' | 'sector' | 'index' | 'market' | 'knowledge' | 'none'
export type StockRouteTargetSource = 'current' | 'history' | 'none'
export type StockResearchData =
  | 'quote'
  | 'history'
  | 'financial'
  | 'valuation'
  | 'news'
  | 'announcements'
  | 'constituents'
  | 'market_breadth'
  | 'sector_ranking'
  | 'factors'
  | 'backtest'
  | 'data_lineage'

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
  routeHint?: StockRouteDecision
  clarificationRound?: number
}

export interface StockRouteDecision {
  scope: 'in_scope' | 'needs_clarification' | 'out_of_scope'
  intent: StockIntent
  relation: StockRouteRelation
  targetKind: StockRouteTargetKind
  targetTerms: string[]
  targetSource: StockRouteTargetSource
  requestedData: StockResearchData[]
  timeRangeDays?: number | null
  factorStyle?: 'balanced' | 'quality' | 'growth' | 'value' | 'momentum' | null
  requiresResearch: boolean
  confidence: number
}

export interface StockRouteRequest {
  requestId: string
  text: string
  history: ResearchHistoryMessage[]
}

export interface StockRouteResult {
  ok: boolean
  decision?: StockRouteDecision
  error?: string
}

export interface ResearchPrepareResult {
  scope: 'in_scope' | 'needs_clarification' | 'out_of_scope'
  intent: StockIntent
  requiresResearch: boolean
  targetKind: 'security' | 'sector' | 'index' | 'market' | 'knowledge' | 'none'
  targets: ResearchTarget[]
  thoughts: string[]
  skills?: string[]
  plan?: {
    relation: StockRouteRelation
    targetSource: StockRouteTargetSource
    requestedData: StockResearchData[]
    plannedTools: string[]
    timeRangeDays?: number | null
  }
  context?: Record<string, any>
  reply?: string
  clarification?: ClarificationCard
}

export interface ClarificationOption {
  id: string
  label: string
  value: string
  description?: string
}

export interface ClarificationCard {
  question: string
  options: ClarificationOption[]
  allowFreeText: boolean
  inputPlaceholder: string
  round: 1 | 2
  maxRounds: 2
}

export const CHART_BAR_LIMIT = 60
const BAR_FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const
const UNTRUNCATED_LIST_KEYS = new Set(['curve'])

function historySummary(rows: any[]): Record<string, any> {
  return {
    points: rows.length,
    ...(rows.length ? { from: rows[0].time, to: rows.at(-1).time } : {}),
  }
}

function chartBars(rows: any[]): Array<Record<string, any>> {
  return rows.slice(-CHART_BAR_LIMIT).map((row) => {
    const bar: Record<string, any> = {}
    for (const field of BAR_FIELDS) if (field in row) bar[field] = row[field]
    return bar
  })
}

function compactContext(context: Record<string, any>, keepBars: boolean): Record<string, any> {
  function compact(value: any, keyHint?: string): any {
    if (Array.isArray(value)) {
      const rows = keyHint && UNTRUNCATED_LIST_KEYS.has(keyHint) ? value : value.slice(0, 20)
      return rows.map((item) => compact(item))
    }
    if (!value || typeof value !== 'object') return value

    const output: Record<string, any> = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'dailyBars' && Array.isArray(child)) {
        const rows = child.filter((item) => item && typeof item === 'object')
        // A stored context already carries the summary built from the full series;
        // recomputing it here would report the trimmed bar count.
        if (!('history' in value)) output.history = historySummary(rows)
        if (keepBars) output.dailyBars = chartBars(rows)
      } else if (key === 'warnings' && Array.isArray(child)) {
        output[key] = child.slice(0, 5).map((warning) => String(warning).slice(0, 180))
      } else {
        output[key] = compact(child, key)
      }
    }
    return output
  }

  return compact(context)
}

/** Context stored on the response and rendered by the UI: keeps chart-ready bars. */
export function compactResearchContext(context: Record<string, any>): Record<string, any> {
  return compactContext(context, true)
}

/** Context handed to a model: bars are replaced by their summary to save tokens. */
export function compactPromptContext(context: Record<string, any>): Record<string, any> {
  return compactContext(context, false)
}
