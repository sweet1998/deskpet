import { app, dialog, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

let configured = false
let manualCheck = false
let periodicTimer: ReturnType<typeof setInterval> | null = null

function messageWindow(getWindow: () => BrowserWindow | null): BrowserWindow | undefined {
  const window = getWindow()
  return window && !window.isDestroyed() ? window : undefined
}

async function showMessage(
  getWindow: () => BrowserWindow | null,
  options: Electron.MessageBoxOptions,
) {
  const window = messageWindow(getWindow)
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
}

export function configureAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (configured || !app.isPackaged) return
  configured = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', async (info) => {
    manualCheck = false
    const result = await showMessage(getWindow, {
      type: 'info',
      title: '发现新版本',
      message: `麦麦 AI 桌宠 ${info.version} 已发布`,
      detail: '是否现在下载？下载期间可以继续使用桌宠。',
      buttons: ['下载更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) await autoUpdater.downloadUpdate()
  })

  autoUpdater.on('update-not-available', async () => {
    if (!manualCheck) return
    manualCheck = false
    await showMessage(getWindow, {
      type: 'info',
      title: '检查更新',
      message: '当前已经是最新版本。',
      buttons: ['知道了'],
    })
  })

  autoUpdater.on('update-downloaded', async (info) => {
    const result = await showMessage(getWindow, {
      type: 'info',
      title: '更新已下载',
      message: `版本 ${info.version} 已准备好`,
      detail: '重启应用后会自动完成安装。',
      buttons: ['重启并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) autoUpdater.quitAndInstall(false, true)
  })

  autoUpdater.on('error', async (error) => {
    if (!manualCheck) return
    manualCheck = false
    await showMessage(getWindow, {
      type: 'error',
      title: '检查更新失败',
      message: '暂时无法检查新版本。',
      detail: error.message,
      buttons: ['知道了'],
    })
  })

  setTimeout(() => { void checkForUpdates(false) }, 20_000)
  periodicTimer = setInterval(() => { void checkForUpdates(false) }, 4 * 60 * 60 * 1000)
  periodicTimer.unref?.()
}

export async function checkForUpdates(manual = true): Promise<boolean> {
  if (!app.isPackaged) return false
  manualCheck = manual
  try {
    await autoUpdater.checkForUpdates()
    return true
  } catch (error) {
    if (manual) {
      manualCheck = false
      throw error
    }
    return false
  }
}

export function stopAutoUpdater(): void {
  if (periodicTimer) clearInterval(periodicTimer)
  periodicTimer = null
}
