import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_MARKET_CONFIG,
  type MarketBridgeConfig,
  type MarketBridgeHealth,
  type MarketContextResult,
} from '../shared/market'

export function normalizeMarketConfig(value: unknown): MarketBridgeConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_MARKET_CONFIG }
  const input = value as Partial<MarketBridgeConfig>
  const openDHost = typeof input.openDHost === 'string' && input.openDHost.trim()
    ? input.openDHost.trim().slice(0, 255)
    : DEFAULT_MARKET_CONFIG.openDHost
  const openDPort = Number.isInteger(input.openDPort) && Number(input.openDPort) > 0 && Number(input.openDPort) < 65536
    ? Number(input.openDPort)
    : DEFAULT_MARKET_CONFIG.openDPort
  let bridgeUrl = DEFAULT_MARKET_CONFIG.bridgeUrl
  if (typeof input.bridgeUrl === 'string') {
    try {
      const parsed = new URL(input.bridgeUrl.trim())
      if (parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
        bridgeUrl = parsed.origin
      }
    } catch { /* use default */ }
  }
  return { openDHost, openDPort, bridgeUrl }
}

async function readJson<T>(url: string, init?: RequestInit, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const body = await response.json() as T & { error?: string }
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
    return body
  } finally {
    clearTimeout(timer)
  }
}

export class MarketBridgeManager {
  private child: ChildProcess | null = null

  constructor(
    private readonly getConfig: () => MarketBridgeConfig,
    private readonly appPath: string,
  ) {}

  async health(): Promise<MarketBridgeHealth> {
    const config = this.getConfig()
    try {
      const result = await readJson<MarketBridgeHealth>(`${config.bridgeUrl}/health`)
      return { ...result, bridgeOwned: Boolean(this.child) }
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        message: error instanceof Error ? error.message : '行情桥不可用',
        bridgeOwned: Boolean(this.child),
      }
    }
  }

  async ensureStarted(): Promise<MarketBridgeHealth> {
    const existing = await this.health()
    if (existing.ok || this.child) return existing

    const python = await this.checkPython()
    if (!python.ok) return python

    const config = this.getConfig()
    let parsed: URL
    try {
      parsed = new URL(config.bridgeUrl)
    } catch {
      return { ok: false, status: 'error', message: '行情桥地址无效' }
    }
    const scriptCandidates = [
      path.join(this.appPath, 'futu-market-bridge.py'),
      path.join(this.appPath, '..', 'futu-market-bridge.py'),
    ]
    const script = scriptCandidates.find((candidate) => fs.existsSync(candidate))
    if (!script) {
      return { ok: false, status: 'error', message: '未找到 futu-market-bridge.py' }
    }
    try {
      this.child = spawn('python3', [
        script,
        '--listen-host', parsed.hostname,
        '--listen-port', parsed.port || '80',
        '--opend-host', config.openDHost,
        '--opend-port', String(config.openDPort),
      ], { stdio: 'ignore' })
      this.child.once('exit', () => { this.child = null })
      this.child.once('error', () => { this.child = null })
    } catch (error) {
      return {
        ok: false,
        status: 'python-missing',
        message: error instanceof Error ? error.message : '无法启动 python3',
      }
    }

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const result = await this.health()
      if (result.ok || result.status !== 'error') return result
      if (!this.child) break
    }
    return this.health()
  }

  private checkPython(): Promise<MarketBridgeHealth> {
    return new Promise((resolve) => {
      const check = spawn('python3', ['-c', 'import aiohttp; import futu'], { stdio: 'ignore' })
      let settled = false
      check.once('error', () => {
        settled = true
        resolve({ ok: false, status: 'python-missing', message: '未找到系统 python3，请先安装 Python 3' })
      })
      check.once('exit', (code) => {
        if (settled) return
        resolve(code === 0
          ? { ok: true, status: 'ready', message: 'Python 行情依赖可用' }
          : { ok: false, status: 'dependency-missing', message: '缺少行情依赖，请运行：pip install futu-api aiohttp' })
      })
    })
  }

  async context(query: string): Promise<MarketContextResult> {
    const ready = await this.ensureStarted()
    if (!ready.ok) {
      return { status: 'unavailable', source: 'futu-opend', error: ready.message }
    }
    const config = this.getConfig()
    try {
      return await readJson<MarketContextResult>(`${config.bridgeUrl}/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.slice(0, 4000) }),
      }, 12000)
    } catch (error) {
      return {
        status: 'unavailable',
        source: 'futu-opend',
        error: error instanceof Error ? error.message : '获取行情失败',
      }
    }
  }

  restartOwned(): void {
    this.stop()
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill('SIGTERM')
  }
}
