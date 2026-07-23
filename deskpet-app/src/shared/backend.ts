export const DESKTOP_BACKEND_URL = 'http://127.0.0.1:18540'

export interface DesktopBackendAccess {
  url: string
  token: string
}

export interface MarketHealth {
  ok: boolean
  status: 'ok' | 'degraded' | 'unavailable'
  provider?: string
  fallbackProvider?: string | null
  source?: string
  stale?: boolean
  asOf?: string | null
  warnings?: string[]
  error?: string | null
}
