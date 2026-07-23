import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, globalShortcut, desktopCapturer, powerMonitor, safeStorage, shell, systemPreferences } from 'electron'
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import { shouldIgnoreMouseEvents, shouldPublishCursorPosition } from './mouse-event-policy'
import { buildPetContextMenuTemplate } from './pet-context-menu'
import { MarketBridgeManager, normalizeMarketConfig } from './market-bridge'
import { BackendManager, readOrCreateBackendToken } from './backend-manager'
import { DESKTOP_BACKEND_URL } from '../shared/backend'
import type { MarketBridgeConfig } from '../shared/market'
import { NativeReminderManager, openNativeUrl } from './native-tools'
import { MacPersistentReminderScheduler } from './persistent-reminders'
import { checkForUpdates, configureAutoUpdater, stopAutoUpdater } from './updater'
import { NativeToolAuditStore } from './native-tool-audit'
import {
  FrontmostAppMonitor,
  desktopVisibilityForBundle,
} from './frontmost-app-monitor'
import {
  clearSecureUserData,
  readSecureUserData,
  writeSecureUserData,
} from './secure-user-data'
import type { SecureUserDataNamespace } from '../shared/secure-user-data'
import { getMacosSpeechAuthorizationStatus, transcribeWithBridge, transcribeWithMacos } from './macos-stt'
import { runElectronSmoke } from './e2e-smoke'
import { appendDiagnosticEvent } from './diagnostics'
import { resolveProductDocumentPath, type ProductDocumentKind } from './product-documents'
import { DoubaoIpcController } from './doubao-ipc'
import { NativeToolsIpcController } from './native-tools-ipc'
import { ExportIpcController } from './export-ipc'

app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('in-process-gpu')
if (process.env.DESKPET_E2E_USER_DATA) {
  app.setPath('userData', process.env.DESKPET_E2E_USER_DATA)
}

const MIN_WINDOW_WIDTH = 80
const MIN_WINDOW_HEIGHT = 120
const CURSOR_HEARTBEAT_MS = 250
const SHORTCUTS = {
  toggleVisible: 'CommandOrControl+Alt+H',
  toggleHoverFade: 'CommandOrControl+Alt+F',
  toggleClickThrough: 'CommandOrControl+Alt+L',
}

interface WindowBoundsState {
  x: number
  y: number
  width: number
  height: number
}

interface WindowState {
  bounds: WindowBoundsState
  alwaysOnTop: boolean
  clickThroughLocked: boolean
  hoverFadeEnabled: boolean
}

interface PetWindowLayoutRequest {
  mode: 'compact' | 'settings'
  petWidth: number
  petHeight: number
  settingsWidth: number
  settingsHeight: number
}

interface PetWindowLayoutResult {
  petX: number
  petY: number
  settingsX: number
  settingsY: number
  settingsWidth: number
  settingsHeight: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampWindowBounds(bounds: WindowBoundsState): WindowBoundsState {
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  const minVisibleSize = 120
  const width = Math.max(bounds.width, MIN_WINDOW_WIDTH)
  const height = Math.max(bounds.height, MIN_WINDOW_HEIGHT)

  return {
    width,
    height,
    x: clamp(bounds.x, area.x + minVisibleSize - width, area.x + area.width - minVisibleSize),
    y: clamp(bounds.y, area.y + minVisibleSize - height, area.y + area.height - minVisibleSize),
  }
}

function getDefaultWindowBounds(width = 600, height = 800): WindowBoundsState {
  const display = screen.getPrimaryDisplay()
  const area = display.workArea
  const safeWidth = Math.min(width, area.width)
  const safeHeight = Math.min(height, area.height)
  return {
    width: safeWidth,
    height: safeHeight,
    x: area.x + area.width - safeWidth - 20,
    y: area.y + area.height - safeHeight - 20,
  }
}

function resetWindowPosition(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const { width, height } = mainWindow.getBounds()
  const bounds = getDefaultWindowBounds(width, height)
  mainWindow.setBounds(bounds)
  saveWindowState()
}

function resetAllLayout(): void {
  resetWindowPosition()
  mainWindow?.webContents.send('reset-model-view')
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState {
  try {
    const parsed = JSON.parse(fs.readFileSync(getWindowStatePath(), 'utf-8')) as Partial<WindowState & WindowBoundsState>
    const sourceBounds = 'bounds' in parsed && parsed.bounds ? parsed.bounds : parsed
    return {
      bounds: clampWindowBounds({
        width: typeof sourceBounds.width === 'number' ? sourceBounds.width : 600,
        height: typeof sourceBounds.height === 'number' ? sourceBounds.height : 800,
        x: typeof sourceBounds.x === 'number' ? sourceBounds.x : 100,
        y: typeof sourceBounds.y === 'number' ? sourceBounds.y : 100,
      }),
      alwaysOnTop: typeof parsed.alwaysOnTop === 'boolean' ? parsed.alwaysOnTop : true,
      clickThroughLocked: typeof parsed.clickThroughLocked === 'boolean' ? parsed.clickThroughLocked : false,
      hoverFadeEnabled: typeof parsed.hoverFadeEnabled === 'boolean' ? parsed.hoverFadeEnabled : false,
    }
  } catch {
    return { bounds: getDefaultWindowBounds(), alwaysOnTop: true, clickThroughLocked: false, hoverFadeEnabled: false }
  }
}

function saveWindowState(): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      lastSavedBounds = petWindowLayoutMode === 'settings' && compactWindowBounds
        ? compactWindowBounds
        : mainWindow.getBounds()
    }
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(getWindowStatePath(), JSON.stringify({
      bounds: lastSavedBounds,
      alwaysOnTop,
      clickThroughLocked,
      hoverFadeEnabled,
    }, null, 2), 'utf-8')
  } catch {
    // ignore window state persistence failures
  }
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let cursorPollTimer: ReturnType<typeof setInterval> | null = null
let lastCursorX: number | null = null
let lastCursorY: number | null = null
let lastCursorPublishedAt: number | null = null
let alwaysOnTop = true
let clickThroughLocked = false
let pointerInteractive = true
let hoverFadeEnabled = false
let lastSavedBounds: WindowBoundsState = { width: 600, height: 800, x: 100, y: 100 }
let petWindowLayoutMode: PetWindowLayoutRequest['mode'] = 'compact'
let compactWindowBounds: WindowBoundsState | null = null
let activePetLayoutRequest: PetWindowLayoutRequest | null = null
let settingsPanelScreenBounds: WindowBoundsState | null = null
let settingsWindowScreenBounds: WindowBoundsState | null = null
let doubaoIpc: DoubaoIpcController | null = null
let marketBridge: MarketBridgeManager | null = null
let backendManager: BackendManager | null = null
let backendAccessToken = ''
let reminderManager: NativeReminderManager | null = null
let nativeToolAudit: NativeToolAuditStore | null = null
const frontmostAppMonitor = new FrontmostAppMonitor()
const ownBundleIds = new Set(['com.sweet1998.deskpet', 'com.github.Electron'])
let manuallyHidden = false

function isMainWindowSender(event: Electron.IpcMainInvokeEvent): boolean {
  return Boolean(mainWindow && BrowserWindow.fromWebContents(event.sender) === mainWindow)
}

function getSecureUserDataPath(namespace: SecureUserDataNamespace): string {
  return path.join(app.getPath('userData'), `${namespace}-data.json`)
}

function isSecureUserDataNamespace(value: unknown): value is SecureUserDataNamespace {
  return value === 'chat' || value === 'agent'
}

function getMarketConfigPath(): string {
  return path.join(app.getPath('userData'), 'market-config.json')
}

function getDiagnosticEventPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'diagnostic-events.jsonl')
}

function readMarketConfig(): MarketBridgeConfig {
  try {
    return normalizeMarketConfig(JSON.parse(fs.readFileSync(getMarketConfigPath(), 'utf-8')))
  } catch {
    return normalizeMarketConfig(null)
  }
}

function writeMarketConfig(input: unknown): MarketBridgeConfig {
  const config = normalizeMarketConfig(input)
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(getMarketConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
  return config
}

function isValidLayoutDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function applyPetWindowLayout(request: PetWindowLayoutRequest): PetWindowLayoutResult | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  if (
    (request.mode !== 'compact' && request.mode !== 'settings')
    || !isValidLayoutDimension(request.petWidth)
    || !isValidLayoutDimension(request.petHeight)
    || !isValidLayoutDimension(request.settingsWidth)
    || !isValidLayoutDimension(request.settingsHeight)
  ) return null

  const current = mainWindow.getBounds()
  const petWidth = Math.max(MIN_WINDOW_WIDTH, Math.round(request.petWidth))
  const petHeight = Math.max(MIN_WINDOW_HEIGHT, Math.round(request.petHeight))
  activePetLayoutRequest = request

  if (request.mode === 'compact') {
    const source = compactWindowBounds ?? current
    const next = {
      x: Math.round(source.x + (source.width - petWidth) / 2),
      y: Math.round(source.y + (source.height - petHeight) / 2),
      width: petWidth,
      height: petHeight,
    }
    petWindowLayoutMode = 'compact'
    compactWindowBounds = next
    settingsPanelScreenBounds = null
    settingsWindowScreenBounds = null
    mainWindow.setBounds(next)
    lastSavedBounds = next
    saveWindowState()
    return {
      petX: next.width / 2,
      petY: next.height / 2,
      settingsX: 0,
      settingsY: 0,
      settingsWidth: 0,
      settingsHeight: 0,
    }
  }

  const compactSource = petWindowLayoutMode === 'compact'
    ? current
    : compactWindowBounds ?? current
  const petBounds = {
    x: Math.round(compactSource.x + (compactSource.width - petWidth) / 2),
    y: Math.round(compactSource.y + (compactSource.height - petHeight) / 2),
    width: petWidth,
    height: petHeight,
  }
  compactWindowBounds = petBounds

  if (
    !settingsPanelScreenBounds
    || petWindowLayoutMode === 'compact'
    || settingsPanelScreenBounds.width !== Math.round(request.settingsWidth)
    || settingsPanelScreenBounds.height !== Math.round(request.settingsHeight)
  ) {
    const display = screen.getDisplayMatching(petBounds)
    const area = display.workArea
    const settingsWidth = Math.min(Math.round(request.settingsWidth), area.width)
    const settingsHeight = Math.min(Math.round(request.settingsHeight), area.height)
    settingsPanelScreenBounds = {
      x: Math.round(area.x + (area.width - settingsWidth) / 2),
      y: Math.round(area.y + (area.height - settingsHeight) / 2),
      width: settingsWidth,
      height: settingsHeight,
    }
    settingsWindowScreenBounds = { ...area }
  }
  const settingsBounds = settingsPanelScreenBounds
  const next = settingsWindowScreenBounds
  if (!next) return null
  petWindowLayoutMode = 'settings'
  if (
    current.x !== next.x
    || current.y !== next.y
    || current.width !== next.width
    || current.height !== next.height
  ) {
    mainWindow.setBounds(next)
  }
  saveWindowState()
  return {
    petX: petBounds.x - next.x + petBounds.width / 2,
    petY: petBounds.y - next.y + petBounds.height / 2,
    settingsX: settingsBounds.x - next.x,
    settingsY: settingsBounds.y - next.y,
    settingsWidth: settingsBounds.width,
    settingsHeight: settingsBounds.height,
  }
}

function setAlwaysOnTopState(flag: boolean): void {
  alwaysOnTop = flag
  mainWindow?.setAlwaysOnTop(flag, 'floating')
  syncDesktopVisibilityMonitoring()
  mainWindow?.webContents.send('desktop-only-changed', !flag)
  saveWindowState()
  createTray()
}

function syncDesktopVisibilityMonitoring(): void {
  frontmostAppMonitor.stop()
  if (alwaysOnTop || process.platform !== 'darwin') {
    if (!manuallyHidden) mainWindow?.showInactive()
    return
  }
  frontmostAppMonitor.start((bundleId) => {
    const window = mainWindow
    if (!window || window.isDestroyed() || manuallyHidden) return
    const visible = desktopVisibilityForBundle(bundleId, ownBundleIds)
    if (visible === true && !window.isVisible()) window.showInactive()
    if (visible === false && window.isVisible()) window.hide()
  })
}

function applyMouseEventPolicy(): void {
  const ignore = shouldIgnoreMouseEvents({ clickThroughLocked, pointerInteractive })
  mainWindow?.setIgnoreMouseEvents(ignore, { forward: true })
}

function setClickThroughLocked(flag: boolean): void {
  clickThroughLocked = flag
  applyMouseEventPolicy()
  saveWindowState()
  createTray()
}

function setHoverFadeEnabled(flag: boolean): void {
  hoverFadeEnabled = flag
  mainWindow?.webContents.send('set-hover-fade', flag)
  saveWindowState()
  createTray()
}

function stopGlobalCursorPolling(): void {
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer)
    cursorPollTimer = null
  }
}

function startGlobalCursorPolling(): void {
  if (cursorPollTimer) return

  cursorPollTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return

    const cursor = screen.getCursorScreenPoint()
    const now = Date.now()
    if (!shouldPublishCursorPosition({
      cursorX: cursor.x,
      cursorY: cursor.y,
      lastCursorX,
      lastCursorY,
      now,
      lastPublishedAt: lastCursorPublishedAt,
      heartbeatMs: CURSOR_HEARTBEAT_MS,
    })) return

    lastCursorX = cursor.x
    lastCursorY = cursor.y
    lastCursorPublishedAt = now

    const bounds = mainWindow.getBounds()
    mainWindow.webContents.send('global-cursor-position', {
      screenX: cursor.x,
      screenY: cursor.y,
      windowX: bounds.x,
      windowY: bounds.y,
      x: cursor.x - bounds.x,
      y: cursor.y - bounds.y
    })
  }, 33)
}

function getAppIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../renderer/icon.png')
}

function createWindow(): void {
  const state = loadWindowState()
  const bounds = state.bounds
  lastSavedBounds = bounds
  alwaysOnTop = state.alwaysOnTop
  clickThroughLocked = state.clickThroughLocked
  pointerInteractive = true
  hoverFadeEnabled = state.hoverFadeEnabled
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    type: 'normal',
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    icon: getAppIconPath(),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating')
  applyMouseEventPolicy()
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openNativeUrl(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() || ''
    if (!current) return
    try {
      const currentUrl = new URL(current)
      const nextUrl = new URL(url)
      if (
        ['http:', 'https:'].includes(currentUrl.protocol)
        && currentUrl.origin === nextUrl.origin
      ) return
      if (currentUrl.protocol === 'file:' && currentUrl.href === nextUrl.href) return
    } catch { /* local file origins do not need navigation */ }
    event.preventDefault()
    void openNativeUrl(url)
  })

  const handleInitialRendererLoad = () => {
    mainWindow?.webContents.send('set-hover-fade', hoverFadeEnabled)
    mainWindow?.webContents.send('desktop-only-changed', !alwaysOnTop)
    const smokeOutput = process.env.DESKPET_E2E_OUTPUT
    if (smokeOutput && mainWindow) {
      void runElectronSmoke(mainWindow, smokeOutput).finally(() => app.exit())
    }
  }
  const rendererLoad = process.env.ELECTRON_RENDERER_URL
    ? mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    : mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  void rendererLoad.then(handleInitialRendererLoad).catch((error) => {
    appendDiagnosticEvent(getDiagnosticEventPath(), {
      type: 'renderer-load-failed',
      reason: error instanceof Error ? error.message : String(error),
    })
    const smokeOutput = process.env.DESKPET_E2E_OUTPUT
    if (smokeOutput) {
      fs.writeFileSync(smokeOutput, JSON.stringify({
        ok: false,
        phase: 'renderer-load',
        checks: {},
        error: error instanceof Error ? error.message : String(error),
      }, null, 2), { mode: 0o600 })
      app.exit(1)
    }
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    appendDiagnosticEvent(getDiagnosticEventPath(), {
      type: 'render-process-gone',
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })
  mainWindow.on('unresponsive', () => {
    appendDiagnosticEvent(getDiagnosticEventPath(), { type: 'window-unresponsive' })
  })

  syncDesktopVisibilityMonitoring()

  mainWindow.on('move', () => {
    if (petWindowLayoutMode === 'compact') {
      compactWindowBounds = mainWindow?.getBounds() ?? null
    }
    saveWindowState()
  })
  mainWindow.on('resize', () => {
    if (petWindowLayoutMode === 'compact') {
      compactWindowBounds = mainWindow?.getBounds() ?? null
    }
    saveWindowState()
  })
  mainWindow.on('close', saveWindowState)

  mainWindow.on('closed', () => {
    stopGlobalCursorPolling()
    mainWindow = null
  })

  startGlobalCursorPolling()
}

function getTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(getAppIconPath())
  return icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 })
}

function formatShortcut(accelerator: string): string {
  return accelerator.replace('CommandOrControl', 'Ctrl')
}

let autoScreenshotTimer: ReturnType<typeof setInterval> | null = null
let autoScreenshotInterval = 60

function setAutoScreenshot(flag: boolean, intervalSec?: number): void {
  if (intervalSec && intervalSec > 0) autoScreenshotInterval = intervalSec
  if (autoScreenshotTimer) { clearInterval(autoScreenshotTimer); autoScreenshotTimer = null }
  if (flag) {
    autoScreenshotTimer = setInterval(captureScreen, autoScreenshotInterval * 1000)
  }
}

async function captureScreenBase64(): Promise<string | null> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1280, height: 720 },
  })
  if (!sources.length) return null
  return sources[0].thumbnail.toPNG().toString('base64')
}

async function captureScreenRegionBase64(): Promise<string | null> {
  if (process.platform !== 'darwin') return captureScreenBase64()
  const target = path.join(app.getPath('temp'), `maimai-screen-${Date.now()}.png`)
  return new Promise((resolve) => {
    execFile('/usr/sbin/screencapture', ['-i', '-x', target], { timeout: 120_000 }, async (error) => {
      try {
        if (error || !fs.existsSync(target)) {
          resolve(null)
          return
        }
        const data = await fs.promises.readFile(target)
        resolve(data.length ? data.toString('base64') : null)
      } catch {
        resolve(null)
      } finally {
        try { await fs.promises.rm(target, { force: true }) } catch { /* already absent */ }
      }
    })
  })
}

function captureScreen(): void {
  void captureScreenBase64()
    .then((base64) => {
      if (base64) mainWindow?.webContents.send('screenshot-captured', base64)
    })
    .catch((error) => console.warn('[deskpet] Screen capture failed:', error))
}

function toggleWindowVisible(): void {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    manuallyHidden = true
    mainWindow.hide()
    return
  }
  manuallyHidden = false
  mainWindow.show()
}

function registerGlobalShortcuts(): void {
  globalShortcut.unregisterAll()

  const bindings: Array<[string, () => void]> = [
    [SHORTCUTS.toggleVisible, toggleWindowVisible],
    [SHORTCUTS.toggleHoverFade, () => setHoverFadeEnabled(!hoverFadeEnabled)],
    [SHORTCUTS.toggleClickThrough, () => setClickThroughLocked(!clickThroughLocked)],
  ]

  for (const [accelerator, callback] of bindings) {
    if (!globalShortcut.register(accelerator, callback)) {
      console.warn(`[deskpet] Global shortcut registration failed: ${accelerator}`)
    }
  }
}

function createTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }

  const lockLabel = clickThroughLocked
    ? `取消锁定穿透（当前鼠标会穿透桌宠，${formatShortcut(SHORTCUTS.toggleClickThrough)}）`
    : `锁定穿透 (${formatShortcut(SHORTCUTS.toggleClickThrough)})`
  tray = new Tray(getTrayIcon())
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `显示/隐藏 (${formatShortcut(SHORTCUTS.toggleVisible)})`, click: toggleWindowVisible },
    { label: '置顶', type: 'checkbox', checked: alwaysOnTop, click: (mi) => { setAlwaysOnTopState(mi.checked) } },
    { label: lockLabel, type: 'checkbox', checked: clickThroughLocked, click: (mi) => { setClickThroughLocked(mi.checked) } },
    { label: `悬停淡化模型 (${formatShortcut(SHORTCUTS.toggleHoverFade)})`, type: 'checkbox', checked: hoverFadeEnabled, click: (mi) => { setHoverFadeEnabled(mi.checked) } },
    { label: '重置模型位置', click: () => { mainWindow?.webContents.send('reset-model-view') } },
    { label: '重置窗口位置', click: () => { resetWindowPosition() } },
    { label: '重置全部布局', click: () => { resetAllLayout() } },
    { type: 'separator' },
    { label: `检查更新（当前 ${app.getVersion()}）`, click: () => { void checkForUpdates() } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit() } }
  ]))
  tray.setToolTip(clickThroughLocked ? 'MaiBot 桌面宠物（已锁定穿透，请从托盘取消）' : 'MaiBot 桌面宠物')
}

app.whenReady().then(() => {
  marketBridge = new MarketBridgeManager(readMarketConfig, app.getAppPath())
  backendAccessToken = readOrCreateBackendToken(path.join(app.getPath('userData'), 'backend-access-token'))
  backendManager = new BackendManager({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  }, path.join(app.getPath('userData'), 'logs', 'backend.log'), backendAccessToken)
  doubaoIpc = new DoubaoIpcController({
    userDataPath: app.getPath('userData'),
    encryption: safeStorage,
    getMainWindow: () => mainWindow,
    e2eOutput: process.env.DESKPET_E2E_OUTPUT,
    e2eModelUrl: process.env.DESKPET_E2E_MODEL_URL,
  })
  doubaoIpc.register(ipcMain)
  if (!process.env.DESKPET_E2E_OUTPUT) void backendManager.ensureStarted()
  reminderManager = new NativeReminderManager(
    path.join(app.getPath('userData'), 'reminders.json'),
    (reminder) => {
      mainWindow?.webContents.send('native-reminder-triggered', reminder)
    },
    process.platform === 'darwin' && !process.env.DESKPET_E2E_OUTPUT
      ? new MacPersistentReminderScheduler(
          path.join(app.getPath('userData'), 'reminder-delivery'),
          path.join(app.getPath('home'), 'Library', 'LaunchAgents'),
        )
      : undefined,
  )
  reminderManager.start()
  nativeToolAudit = new NativeToolAuditStore(
    path.join(app.getPath('userData'), 'native-tool-audit.json'),
  )
  new NativeToolsIpcController({
    getMainWindow: () => mainWindow,
    getReminderManager: () => reminderManager,
    getAuditStore: () => nativeToolAudit,
    getDoubaoConfig: () => doubaoIpc?.getConfig() ?? { apiKey: '', model: '' },
    ocrPaths: {
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      tempPath: app.getPath('temp'),
      isPackaged: app.isPackaged,
    },
    setAutoScreenshotInterval: (seconds) => {
      autoScreenshotInterval = Math.max(1, Math.min(3600, seconds))
      if (autoScreenshotTimer) setAutoScreenshot(true, autoScreenshotInterval)
    },
    captureScreen: captureScreenBase64,
    captureScreenRegion: captureScreenRegionBase64,
  }).register(ipcMain)
  new ExportIpcController({
    getMainWindow: () => mainWindow,
    getBackendHealth: () => backendManager?.health() ?? Promise.resolve({
      ok: false,
      status: 'missing',
      message: '未初始化',
      owned: false,
    }),
    diagnosticEventPath: getDiagnosticEventPath(),
    backendLogPath: path.join(app.getPath('userData'), 'logs', 'backend.log'),
  }).register(ipcMain)
  ipcMain.handle('drag-window', (event, { dx, dy }: { dx: number; dy: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== mainWindow) return
    if (
      petWindowLayoutMode === 'settings'
      && compactWindowBounds
      && activePetLayoutRequest
    ) {
      compactWindowBounds = {
        ...compactWindowBounds,
        x: compactWindowBounds.x + dx,
        y: compactWindowBounds.y + dy,
      }
      const layout = applyPetWindowLayout(activePetLayoutRequest)
      win.webContents.send('pet-window-layout-changed', layout)
      return
    }
    const bounds = win.getBounds()
    win.setPosition(bounds.x + dx, bounds.y + dy)
  })

  ipcMain.handle('set-pet-window-layout', (event, request: PetWindowLayoutRequest) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return null
    return applyPetWindowLayout(request)
  })

  ipcMain.handle('set-always-on-top', (event, flag: boolean) => {
    if (!isMainWindowSender(event) || typeof flag !== 'boolean') return
    setAlwaysOnTopState(flag)
  })

  ipcMain.handle('get-desktop-only', (event) => (
    isMainWindowSender(event) ? !alwaysOnTop : false
  ))

  ipcMain.handle('set-desktop-only', (event, flag: boolean) => {
    if (!isMainWindowSender(event) || typeof flag !== 'boolean') return
    setAlwaysOnTopState(!flag)
  })

  ipcMain.handle('set-click-through-locked', (event, flag: boolean) => {
    if (!isMainWindowSender(event) || typeof flag !== 'boolean') return
    setClickThroughLocked(flag)
  })

  ipcMain.handle('set-pet-hit-test-interactive', (event, interactive: unknown) => {
    if (
      !mainWindow ||
      BrowserWindow.fromWebContents(event.sender) !== mainWindow ||
      typeof interactive !== 'boolean'
    ) return

    pointerInteractive = interactive
    applyMouseEventPolicy()
  })

  ipcMain.handle('show-pet-context-menu', (event, request: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== mainWindow) return

    const template = buildPetContextMenuTemplate(request, (command) => {
      win.webContents.send('pet-context-command', command)
    })
    Menu.buildFromTemplate(template).popup({ window: win })
  })

  ipcMain.handle('minimize-window', (event) => {
    if (!isMainWindowSender(event)) return
    mainWindow?.minimize()
  })

  ipcMain.handle('stt-transcribe', async (event, audioBuffer: ArrayBuffer, url?: string) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) {
      return { ok: false, error: '无效的调用来源' }
    }
    const systemResult = process.platform === 'darwin'
      ? await transcribeWithMacos(audioBuffer, {
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          tempPath: app.getPath('temp'),
          isPackaged: app.isPackaged,
        })
      : { ok: false, error: '内置语音识别当前仅支持 macOS' }
    if (systemResult.ok || !url?.trim()) return systemResult
    const bridgeResult = await transcribeWithBridge(audioBuffer, url.trim())
    return bridgeResult.ok ? bridgeResult : {
      ok: false,
      error: `${systemResult.error || '系统语音识别失败'}；${bridgeResult.error || 'STT Bridge 不可用'}`,
    }
  })

  ipcMain.handle('get-voice-permission-status', async (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return null
    if (process.platform !== 'darwin') {
      return {
        platformSupported: false,
        helperAvailable: false,
        microphone: 'unavailable',
        speechRecognition: 'unavailable',
      }
    }
    const speech = await getMacosSpeechAuthorizationStatus({
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      tempPath: app.getPath('temp'),
      isPackaged: app.isPackaged,
    })
    return {
      platformSupported: true,
      helperAvailable: speech.helperAvailable,
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      speechRecognition: speech.status,
    }
  })

  ipcMain.handle('read-secure-user-data', (event, namespace: unknown) => {
    if (
      BrowserWindow.fromWebContents(event.sender) !== mainWindow
      || !isSecureUserDataNamespace(namespace)
    ) return { available: false, exists: false, error: '无效的调用来源' }
    return readSecureUserData(getSecureUserDataPath(namespace), safeStorage)
  })

  ipcMain.handle('write-secure-user-data', (event, namespace: unknown, value: unknown) => {
    if (
      BrowserWindow.fromWebContents(event.sender) !== mainWindow
      || !isSecureUserDataNamespace(namespace)
    ) return false
    try {
      return writeSecureUserData(getSecureUserDataPath(namespace), value, safeStorage)
    } catch (error) {
      console.warn('[deskpet] Secure user data write failed:', error)
      return false
    }
  })

  ipcMain.handle('clear-secure-user-data', (event, namespace: unknown) => {
    if (
      BrowserWindow.fromWebContents(event.sender) !== mainWindow
      || !isSecureUserDataNamespace(namespace)
    ) return false
    clearSecureUserData(getSecureUserDataPath(namespace))
    return true
  })

  ipcMain.handle('get-app-version', (event) => (
    isMainWindowSender(event) ? app.getVersion() : ''
  ))
  ipcMain.handle('open-product-document', async (event, kind: ProductDocumentKind) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow || !['privacy', 'terms'].includes(kind)) return false
    const filePath = resolveProductDocumentPath(kind, {
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
    })
    if (!filePath) return false
    return (await shell.openPath(filePath)) === ''
  })
  ipcMain.handle('get-backend-access', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return null
    return { url: DESKTOP_BACKEND_URL, token: backendAccessToken }
  })
  ipcMain.handle('get-system-idle-time', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return 0
    return powerMonitor.getSystemIdleTime()
  })
  ipcMain.handle('check-for-updates', async (event) => {
    if (!isMainWindowSender(event)) return false
    try { return await checkForUpdates(true) } catch { return false }
  })

  ipcMain.handle('get-market-config', (event) => (
    isMainWindowSender(event) ? readMarketConfig() : null
  ))

  ipcMain.handle('save-market-config', (event, input: unknown) => {
    if (!isMainWindowSender(event)) return null
    const config = writeMarketConfig(input)
    marketBridge?.restartOwned()
    return config
  })

  ipcMain.handle('test-market-connection', async (event) => {
    if (!isMainWindowSender(event)) {
      return { ok: false, status: 'error', message: '无效的调用来源' }
    }
    return marketBridge?.ensureStarted() ?? {
      ok: false,
      status: 'error',
      message: '行情桥尚未初始化',
    }
  })

  ipcMain.handle('get-market-context', async (event, query: unknown) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow || typeof query !== 'string') {
      return { status: 'unavailable', source: 'futu-opend', error: '无效的行情请求' }
    }
    return marketBridge?.context(query) ?? {
      status: 'unavailable',
      source: 'futu-opend',
      error: '行情桥尚未初始化',
    }
  })

  ipcMain.handle('close-window', (event) => {
    if (!isMainWindowSender(event)) return
    mainWindow?.close()
  })

  createWindow()
  createTray()
  if (!process.env.DESKPET_E2E_OUTPUT) configureAutoUpdater(() => mainWindow)
  registerGlobalShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopAutoUpdater()
  doubaoIpc?.stop()
  doubaoIpc = null
  reminderManager?.stop()
  reminderManager = null
  nativeToolAudit = null
  backendManager?.stop()
  backendManager = null
  marketBridge?.stop()
  marketBridge = null
  stopGlobalCursorPolling()
  frontmostAppMonitor.stop()
  globalShortcut.unregisterAll()
  if (tray) { tray.destroy(); tray = null }
})
