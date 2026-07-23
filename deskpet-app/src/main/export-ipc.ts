import fs from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  systemPreferences,
  type IpcMain,
  type SaveDialogOptions,
} from 'electron'
import type { BackendHealth } from './backend-manager'
import { readDiagnosticLogTail } from './diagnostics'

interface ExportIpcOptions {
  getMainWindow: () => BrowserWindow | null
  getBackendHealth: () => Promise<BackendHealth>
  diagnosticEventPath: string
  backendLogPath: string
}

interface TextExportPayload {
  title: string
  content: string
}

export function normalizeTextExport(
  value: unknown,
  fallbackTitle: string,
  maxContentLength: number,
): TextExportPayload | null {
  if (!value || typeof value !== 'object') return null
  const input = value as { title?: unknown; content?: unknown }
  if (
    typeof input.content !== 'string'
    || !input.content.trim()
    || input.content.length > maxContentLength
  ) return null
  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
    : fallbackTitle
  return { title, content: input.content }
}

export class ExportIpcController {
  constructor(private readonly options: ExportIpcOptions) {}

  register(ipcMain: Pick<IpcMain, 'handle'>): void {
    ipcMain.handle('save-agent-result', async (event, value: unknown) => {
      if (!this.isMainSender(event)) return false
      const payload = normalizeTextExport(value, '麦麦任务结果', 2_000_000)
      if (!payload) return false
      return this.saveTextFile({
        title: '保存 Agent 结果',
        defaultPath: `${payload.title}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }],
      }, `# ${payload.title}\n\n${payload.content}\n`)
    })

    ipcMain.handle('export-conversation', async (event, value: unknown) => {
      if (!this.isMainSender(event)) return false
      const payload = normalizeTextExport(value, '麦麦对话', 4_000_000)
      if (!payload) return false
      return this.saveTextFile({
        title: '导出对话',
        defaultPath: `${payload.title}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }],
      }, `${payload.content.trim()}\n`)
    })

    ipcMain.handle('export-diagnostics', async (event) => {
      if (!this.isMainSender(event)) return false
      const report = {
        generatedAt: new Date().toISOString(),
        app: {
          version: app.getVersion(),
          packaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
        },
        permissions: process.platform === 'darwin' ? {
          microphone: systemPreferences.getMediaAccessStatus('microphone'),
          screen: systemPreferences.getMediaAccessStatus('screen'),
        } : {},
        backend: await this.options.getBackendHealth(),
        diagnosticEvents: readDiagnosticLogTail(this.options.diagnosticEventPath, app.getPath('home')),
        backendLog: readDiagnosticLogTail(this.options.backendLogPath, app.getPath('home')),
      }
      return this.saveTextFile({
        title: '导出诊断报告',
        defaultPath: `麦麦诊断-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      }, `${JSON.stringify(report, null, 2)}\n`, 0o600)
    })
  }

  private isMainSender(event: Electron.IpcMainInvokeEvent): boolean {
    const mainWindow = this.options.getMainWindow()
    return Boolean(mainWindow && BrowserWindow.fromWebContents(event.sender) === mainWindow)
  }

  private async saveTextFile(
    options: SaveDialogOptions,
    content: string,
    mode?: number,
  ): Promise<boolean> {
    try {
      const mainWindow = this.options.getMainWindow()
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return false
      await fs.promises.mkdir(path.dirname(result.filePath), { recursive: true })
      await fs.promises.writeFile(result.filePath, content, { encoding: 'utf-8', ...(mode ? { mode } : {}) })
      return true
    } catch (error) {
      console.warn('[deskpet] Export failed:', error)
      return false
    }
  }
}
