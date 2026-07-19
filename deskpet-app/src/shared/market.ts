export interface MarketBridgeConfig {
  openDHost: string
  openDPort: number
  bridgeUrl: string
}

export interface MarketBridgeHealth {
  ok: boolean
  status: 'ready' | 'python-missing' | 'dependency-missing' | 'opend-unavailable' | 'permission-denied' | 'error'
  message: string
  bridgeOwned?: boolean
}

export interface MarketCandidate {
  code: string
  name: string
  market: string
}

export interface MarketDailyBar {
  time: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}

export interface MarketCompanyProfile {
  industry: string | null
  listingDate: string | null
  totalShares: number | null
  floatShares: number | null
  floatMarketCap: number | null
}

export interface MarketFinancialSnapshot {
  reportDate: string | null
  eps: number | null
  revenue: number | null
  revenueYoY: number | null
  netProfit: number | null
  netProfitYoY: number | null
  roe: number | null
  grossMargin: number | null
  netMargin: number | null
  debtRatio: number | null
  operatingCashFlowPerShare: number | null
}

export interface MarketTechnicalSummary {
  return5d: number | null
  return20d: number | null
  return60d: number | null
  ma5: number | null
  ma20: number | null
  ma60: number | null
  volatility20d: number | null
  maxDrawdown60d: number | null
}

export interface MarketSecurityContext extends MarketCandidate {
  price: number | null
  changePercent: number | null
  dataTime: string
  marketStatus: 'trading' | 'closed' | 'unknown'
  stale: boolean
  peRatio: number | null
  pbRatio: number | null
  marketCap: number | null
  dailyBars: MarketDailyBar[]
  profile: MarketCompanyProfile
  financial: MarketFinancialSnapshot
  technical: MarketTechnicalSummary
  dataSources: Record<string, string>
  warnings: string[]
}

export interface MarketContextResult {
  status: 'ok' | 'ambiguous' | 'unavailable' | 'no-symbol'
  source: string
  asOf?: string
  marketStatus?: string
  securities?: MarketSecurityContext[]
  candidates?: MarketCandidate[]
  error?: string
}

export const DEFAULT_MARKET_CONFIG: MarketBridgeConfig = {
  openDHost: '127.0.0.1',
  openDPort: 11111,
  bridgeUrl: 'http://127.0.0.1:18531',
}
