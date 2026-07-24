import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, type IpcMain } from 'electron'
import {
  detectDoubaoCapabilities,
  normalizeDoubaoConfig,
  requestDoubao,
  requestDoubaoConversation,
  type StoredDoubaoConfig,
} from './doubao-client'
import {
  clearSecureDoubaoConfig,
  readSecureDoubaoConfig,
  writeSecureDoubaoConfig,
  type EncryptionProvider,
} from './secure-doubao-config'
import {
  DOUBAO_BASE_URL,
  type DoubaoCapabilityReport,
  type DoubaoChatRequest,
  type DoubaoConfigInput,
  type DoubaoConfigView,
} from '../shared/doubao'

interface DoubaoIpcOptions {
  userDataPath: string
  encryption: EncryptionProvider
  getMainWindow: () => BrowserWindow | null
  e2eOutput?: string
  e2eModelUrl?: string
}

export function resolveE2eDoubaoBaseUrl(
  output: string | undefined,
  candidate: string | undefined,
): string | undefined {
  if (!output || !candidate?.trim()) return undefined
  try {
    const url = new URL(candidate.trim())
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return undefined
    return url.toString().replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

export class DoubaoIpcController {
  private readonly configPath: string
  private readonly capabilitiesPath: string
  private readonly requests = new Map<string, AbortController>()
  private readonly baseUrl: string | undefined

  constructor(private readonly options: DoubaoIpcOptions) {
    this.configPath = path.join(options.userDataPath, 'doubao-config.json')
    this.capabilitiesPath = path.join(options.userDataPath, 'doubao-capabilities.json')
    this.baseUrl = resolveE2eDoubaoBaseUrl(options.e2eOutput, options.e2eModelUrl)
  }

  getConfig(): StoredDoubaoConfig {
    return readSecureDoubaoConfig(this.configPath, this.options.encryption)
  }

  register(ipcMain: Pick<IpcMain, 'handle'>): void {
    ipcMain.handle('get-doubao-config', (event) => (
      this.isMainSender(event) ? this.configView() : this.emptyConfigView()
    ))
    ipcMain.handle('save-doubao-config', (event, input: DoubaoConfigInput) => {
      if (!this.isMainSender(event)) return this.emptyConfigView()
      return this.configView(this.writeConfig(input))
    })
    ipcMain.handle('clear-doubao-config', (event) => {
      if (!this.isMainSender(event)) return false
      clearSecureDoubaoConfig(this.configPath)
      try { fs.rmSync(this.capabilitiesPath, { force: true }) } catch { /* already absent */ }
      return true
    })
    ipcMain.handle('test-doubao-connection', async (event, input: DoubaoConfigInput) => {
      if (!this.isMainSender(event)) return { ok: false, error: '无效的调用来源' }
      const config = normalizeDoubaoConfig(input, this.getConfig())
      const result = await requestDoubao(
        config,
        [{ role: 'user', content: '只回复“连接成功”四个字。' }],
        { maxTokens: 16, baseUrl: this.baseUrl },
      )
      if (result.ok) this.writeConfig(config)
      return result
    })
    ipcMain.handle('detect-doubao-capabilities', async (event, input: DoubaoConfigInput) => {
      if (!this.isMainSender(event)) return {
        model: '', checkedAt: Date.now(), text: false, streaming: false, vision: false,
        errors: { text: '无效的调用来源' },
      }
      const config = normalizeDoubaoConfig(input, this.getConfig())
      const report = await detectDoubaoCapabilities(config, { baseUrl: this.baseUrl })
      if (report.text && report.streaming) {
        this.writeConfig(config)
        this.writeCapabilities(report)
      }
      return report
    })
    ipcMain.handle('doubao-chat', async (event, input: DoubaoChatRequest) => {
      if (!this.isMainSender(event)) return { ok: false, error: '无效的调用来源' }
      if (
        !input || typeof input.requestId !== 'string' || !input.requestId
        || !Array.isArray(input.messages)
      ) return { ok: false, error: '无效的豆包请求' }

      const controller = new AbortController()
      this.requests.get(input.requestId)?.abort()
      this.requests.set(input.requestId, controller)
      try {
        return await requestDoubaoConversation(this.getConfig(), input.messages, {
          signal: controller.signal,
          baseUrl: this.baseUrl,
          maxTokens: Math.max(512, Math.min(4096, Number(input.maxTokens) || 1400)),
          onDelta: (delta) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('doubao-chat-delta', { requestId: input.requestId, delta })
            }
          },
        })
      } finally {
        if (this.requests.get(input.requestId) === controller) this.requests.delete(input.requestId)
      }
    })
    ipcMain.handle('cancel-doubao-chat', (event, requestId: unknown) => {
      if (!this.isMainSender(event) || typeof requestId !== 'string') return false
      const controller = this.requests.get(requestId)
      controller?.abort()
      return Boolean(controller)
    })
  }

  stop(): void {
    for (const request of this.requests.values()) request.abort()
    this.requests.clear()
  }

  private isMainSender(event: Electron.IpcMainInvokeEvent): boolean {
    const mainWindow = this.options.getMainWindow()
    return Boolean(mainWindow && BrowserWindow.fromWebContents(event.sender) === mainWindow)
  }

  private writeConfig(input: DoubaoConfigInput): StoredDoubaoConfig {
    return writeSecureDoubaoConfig(this.configPath, input, this.options.encryption)
  }

  private readCapabilities(model: string): DoubaoCapabilityReport | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.capabilitiesPath, 'utf-8')) as Partial<DoubaoCapabilityReport>
      if (value.model !== model || typeof value.checkedAt !== 'number') return undefined
      return {
        model,
        checkedAt: value.checkedAt,
        text: value.text === true,
        streaming: value.streaming === true,
        vision: value.vision === true,
        errors: value.errors && typeof value.errors === 'object' ? value.errors : {},
      }
    } catch {
      return undefined
    }
  }

  private writeCapabilities(report: DoubaoCapabilityReport): void {
    fs.mkdirSync(this.options.userDataPath, { recursive: true })
    fs.writeFileSync(this.capabilitiesPath, JSON.stringify(report, null, 2), { mode: 0o600 })
  }

  private configView(config = this.getConfig()): DoubaoConfigView {
    const capabilities = this.readCapabilities(config.model)
    return {
      baseUrl: DOUBAO_BASE_URL,
      model: config.model,
      hasApiKey: Boolean(config.apiKey),
      ...(capabilities ? { capabilities } : {}),
    }
  }

  private emptyConfigView(): DoubaoConfigView {
    return { baseUrl: DOUBAO_BASE_URL, model: '', hasApiKey: false }
  }
}
