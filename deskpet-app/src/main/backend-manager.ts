import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DESKTOP_BACKEND_URL } from '../shared/backend'

const BACKEND_TOKEN_PATTERN = /^[a-f0-9]{64}$/

export interface BackendHealth {
  ok: boolean
  status: 'ready' | 'starting' | 'missing' | 'error'
  message: string
  owned: boolean
  modelConfigured?: boolean
}

export interface BackendLaunchOptions {
  appPath: string
  resourcesPath: string
  isPackaged: boolean
  platform?: NodeJS.Platform
}

export interface BackendLaunch {
  command: string
  args: string[]
  cwd: string
}

export function readOrCreateBackendToken(
  filePath: string,
  createToken = () => randomBytes(32).toString('hex'),
): string {
  try {
    const existing = fs.readFileSync(filePath, 'utf-8').trim()
    if (BACKEND_TOKEN_PATTERN.test(existing)) return existing
  } catch { /* create below */ }

  const token = createToken()
  if (!BACKEND_TOKEN_PATTERN.test(token)) throw new Error('无法生成本地研究服务访问令牌')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp`
  fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
  fs.chmodSync(filePath, 0o600)
  return token
}

export function resolveBackendLaunch(options: BackendLaunchOptions): BackendLaunch | null {
  if (options.isPackaged) {
    const executable = path.join(
      options.resourcesPath,
      'backend',
      options.platform === 'win32' ? 'deskpet-backend.exe' : 'deskpet-backend',
    )
    return fs.existsSync(executable)
      ? { command: executable, args: [], cwd: path.dirname(executable) }
      : null
  }

  const backendRoots = [
    path.resolve(options.appPath, '..', 'backend'),
    path.resolve(options.appPath, 'backend'),
  ]
  const backendRoot = backendRoots.find((candidate) => (
    fs.existsSync(path.join(candidate, 'desktop_entry.py'))
  ))
  if (!backendRoot) return null

  const pythonCandidates = options.platform === 'win32'
    ? [path.join(backendRoot, '.venv', 'Scripts', 'python.exe'), 'python']
    : [path.join(backendRoot, '.venv', 'bin', 'python'), 'python3']
  const python = pythonCandidates.find((candidate) => (
    !path.isAbsolute(candidate) || fs.existsSync(candidate)
  ))
  if (!python) return null
  return {
    command: python,
    args: [path.join(backendRoot, 'desktop_entry.py')],
    cwd: backendRoot,
  }
}

async function readHealth(timeoutMs = 1200): Promise<{ modelConfigured?: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${DESKTOP_BACKEND_URL}/health`, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as { modelConfigured?: boolean }
  } finally {
    clearTimeout(timer)
  }
}

export class BackendManager {
  private child: ChildProcess | null = null
  private startPromise: Promise<BackendHealth> | null = null

  constructor(
    private readonly launchOptions: BackendLaunchOptions,
    private readonly logPath: string,
    private readonly accessToken: string,
  ) {}

  async health(): Promise<BackendHealth> {
    try {
      const result = await readHealth()
      return {
        ok: true,
        status: 'ready',
        message: '本地研究服务已就绪',
        owned: Boolean(this.child),
        modelConfigured: Boolean(result.modelConfigured),
      }
    } catch (error) {
      return {
        ok: false,
        status: 'error',
        message: error instanceof Error ? error.message : '本地研究服务不可用',
        owned: Boolean(this.child),
      }
    }
  }

  ensureStarted(): Promise<BackendHealth> {
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => { this.startPromise = null })
    }
    return this.startPromise
  }

  private async start(): Promise<BackendHealth> {
    const existing = await this.health()
    if (existing.ok || this.child) return existing

    const launch = resolveBackendLaunch(this.launchOptions)
    if (!launch) {
      return {
        ok: false,
        status: 'missing',
        message: this.launchOptions.isPackaged
          ? '安装包缺少本地研究服务'
          : '未找到 backend/.venv，请先安装后端依赖',
        owned: false,
      }
    }

    fs.mkdirSync(path.dirname(this.logPath), { recursive: true })
    const log = fs.openSync(this.logPath, 'a')
    try {
      this.child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: {
          ...process.env,
          DESKPET_ENV: 'desktop',
          DESKPET_API_TOKEN: this.accessToken,
          DESKPET_CORS_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173,null',
          MARKET_CACHE_PATH: process.env.MARKET_CACHE_PATH || path.join(
            path.dirname(this.logPath),
            'market-cache.sqlite3',
          ),
          PYTHONUNBUFFERED: '1',
        },
        stdio: ['ignore', log, log],
      })
    } catch (error) {
      fs.closeSync(log)
      this.child = null
      return {
        ok: false,
        status: 'error',
        message: error instanceof Error ? error.message : '无法启动本地研究服务',
        owned: false,
      }
    }
    fs.closeSync(log)
    this.child.once('exit', () => { this.child = null })
    this.child.once('error', () => { this.child = null })

    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const result = await this.health()
      if (result.ok) return result
      if (!this.child) break
    }
    const result = await this.health()
    return result.ok ? result : {
      ...result,
      status: 'error',
      message: `本地研究服务启动失败，日志：${this.logPath}`,
    }
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill('SIGTERM')
  }
}
