import { BrowserWindow, type IpcMain } from 'electron'
import type { StoredDoubaoConfig } from './doubao-client'
import { recognizeWithMacosVision, type MacosOcrPaths } from './macos-ocr'
import { NativeToolAuditStore } from './native-tool-audit'
import { planNativeTools } from './native-tool-planner'
import {
  NativeReminderManager,
  extractNativeFile,
  openNativeUrl,
  revealNativePath,
  writeNativeClipboard,
} from './native-tools'
import type {
  NativeFileExtractionInput,
  NativeReminderInput,
  NativeToolAuditInput,
  NativeToolPlanningRequest,
} from '../shared/native-tools'

interface NativeToolsIpcOptions {
  getMainWindow: () => BrowserWindow | null
  getReminderManager: () => NativeReminderManager | null
  getAuditStore: () => NativeToolAuditStore | null
  getDoubaoConfig: () => StoredDoubaoConfig
  ocrPaths: MacosOcrPaths
  setAutoScreenshotInterval: (seconds: number) => void
  captureScreen: () => Promise<string | null>
  captureScreenRegion: () => Promise<string | null>
}

export class NativeToolsIpcController {
  constructor(private readonly options: NativeToolsIpcOptions) {}

  register(ipcMain: Pick<IpcMain, 'handle'>): void {
    ipcMain.handle('set-auto-screenshot-interval', (event, seconds: unknown) => {
      if (!this.isMainSender(event) || typeof seconds !== 'number' || !Number.isFinite(seconds)) return false
      this.options.setAutoScreenshotInterval(seconds)
      return true
    })
    ipcMain.handle('capture-screen', async (event) => {
      if (!this.isMainSender(event)) return null
      try { return await this.options.captureScreen() } catch { return null }
    })
    ipcMain.handle('capture-screen-region', async (event) => {
      if (!this.isMainSender(event)) return null
      return this.options.captureScreenRegion()
    })
    ipcMain.handle('extract-native-file', async (event, input: NativeFileExtractionInput) => {
      if (!this.isMainSender(event)) return { ok: false, name: '', error: '无效的调用来源' }
      return extractNativeFile(input, {
        ocr: (buffer, extension) => recognizeWithMacosVision(buffer, extension, this.options.ocrPaths),
      })
    })
    ipcMain.handle('list-native-reminders', (event) => (
      this.isMainSender(event) ? this.options.getReminderManager()?.list() ?? [] : []
    ))
    ipcMain.handle('plan-native-tools', async (event, input: NativeToolPlanningRequest) => {
      if (
        !this.isMainSender(event)
        || !input
        || typeof input.text !== 'string'
        || !input.text.trim()
        || input.text.length > 4_000
      ) return { intents: [], error: '无效的工具规划请求' }
      return planNativeTools(this.options.getDoubaoConfig(), {
        text: input.text,
        now: Date.now(),
        reminders: this.options.getReminderManager()?.list() ?? [],
      })
    })
    ipcMain.handle('create-native-reminder', (event, input: NativeReminderInput) => {
      const manager = this.options.getReminderManager()
      if (!this.isMainSender(event) || !manager) return null
      try { return manager.create(input) } catch (error) {
        return { error: error instanceof Error ? error.message : '创建提醒失败' }
      }
    })
    ipcMain.handle('cancel-native-reminder', (event, id: unknown) => {
      if (!this.isMainSender(event) || typeof id !== 'string') return false
      return this.options.getReminderManager()?.cancel(id) ?? false
    })
    ipcMain.handle('clear-native-reminders', (event) => {
      const manager = this.options.getReminderManager()
      if (!this.isMainSender(event) || !manager) return false
      manager.clear()
      return true
    })
    ipcMain.handle('append-native-tool-audit', (event, input: NativeToolAuditInput) => {
      if (!this.isMainSender(event)) return null
      return this.options.getAuditStore()?.append(input) ?? null
    })
    ipcMain.handle('list-native-tool-audit', (event) => (
      this.isMainSender(event) ? this.options.getAuditStore()?.list() ?? [] : []
    ))
    ipcMain.handle('clear-native-tool-audit', (event) => {
      const store = this.options.getAuditStore()
      if (!this.isMainSender(event) || !store) return false
      store.clear()
      return true
    })
    ipcMain.handle('write-native-clipboard', (event, text: unknown) => (
      this.isMainSender(event) ? writeNativeClipboard(text) : false
    ))
    ipcMain.handle('open-native-url', (event, url: unknown) => (
      this.isMainSender(event) ? openNativeUrl(url) : false
    ))
    ipcMain.handle('reveal-native-path', (event, targetPath: unknown) => (
      this.isMainSender(event) ? revealNativePath(targetPath) : false
    ))
  }

  private isMainSender(event: Electron.IpcMainInvokeEvent): boolean {
    const mainWindow = this.options.getMainWindow()
    return Boolean(mainWindow && BrowserWindow.fromWebContents(event.sender) === mainWindow)
  }
}
