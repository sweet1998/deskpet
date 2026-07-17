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
}

export interface MarketContextResult {
  status: 'ok' | 'ambiguous' | 'unavailable' | 'no-symbol'
  source: 'futu-opend'
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
