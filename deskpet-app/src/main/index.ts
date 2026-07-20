import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, globalShortcut, desktopCapturer, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import http from 'http'
import { shouldIgnoreMouseEvents, shouldPublishCursorPosition } from './mouse-event-policy'
import { buildPetContextMenuTemplate } from './pet-context-menu'
import { requestDoubao, normalizeDoubaoConfig, type StoredDoubaoConfig } from './doubao-client'
import { DOUBAO_BASE_URL, type DoubaoChatRequest, type DoubaoConfigInput } from '../shared/doubao'
import { MarketBridgeManager, normalizeMarketConfig } from './market-bridge'
import type { MarketBridgeConfig } from '../shared/market'

app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('in-process-gpu')

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
const doubaoRequests = new Map<string, AbortController>()
let marketBridge: MarketBridgeManager | null = null

function getDoubaoConfigPath(): string {
  return path.join(app.getPath('userData'), 'doubao-config.json')
}

function getMarketConfigPath(): string {
  return path.join(app.getPath('userData'), 'market-config.json')
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

function readDoubaoConfig(): StoredDoubaoConfig {
  try {
    return normalizeDoubaoConfig(JSON.parse(fs.readFileSync(getDoubaoConfigPath(), 'utf-8')))
  } catch {
    return { apiKey: '', model: '' }
  }
}

function writeDoubaoConfig(input: DoubaoConfigInput): StoredDoubaoConfig {
  const config = normalizeDoubaoConfig(input, readDoubaoConfig())
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(getDoubaoConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
  return config
}

function getDoubaoConfigView(config = readDoubaoConfig()) {
  return {
    baseUrl: DOUBAO_BASE_URL,
    model: config.model,
    hasApiKey: Boolean(config.apiKey),
  }
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
  mainWindow?.webContents.send('desktop-only-changed', !flag)
  saveWindowState()
  createTray()
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

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow?.webContents.send('set-hover-fade', hoverFadeEnabled)
    mainWindow?.webContents.send('desktop-only-changed', !alwaysOnTop)
  })

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

function captureScreen(): void {
  // maxSize limits thumbnail to avoid WebSocket frame overflow
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } }).then((sources) => {
    if (sources.length === 0) return
    const png = sources[0].thumbnail.toPNG()
    const b64 = png.toString('base64')
    mainWindow?.webContents.send('screenshot-captured', b64)
  })
}

function toggleWindowVisible(): void {
  if (!mainWindow) return
  mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show()
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
    { label: '截图识图', click: () => { captureScreen() } },
    { label: '自动截图', type: 'checkbox', checked: false, click: (mi) => { setAutoScreenshot(mi.checked) } },
    { label: '重置模型位置', click: () => { mainWindow?.webContents.send('reset-model-view') } },
    { label: '重置窗口位置', click: () => { resetWindowPosition() } },
    { label: '重置全部布局', click: () => { resetAllLayout() } },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit() } }
  ]))
  tray.setToolTip(clickThroughLocked ? 'MaiBot 桌面宠物（已锁定穿透，请从托盘取消）' : 'MaiBot 桌面宠物')
}

app.whenReady().then(() => {
  marketBridge = new MarketBridgeManager(readMarketConfig, app.getAppPath())
  createWindow()
  createTray()
  registerGlobalShortcuts()

  ipcMain.handle('drag-window', (event, { dx, dy }: { dx: number; dy: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
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

  ipcMain.handle('set-always-on-top', (_event, flag: boolean) => {
    setAlwaysOnTopState(flag)
  })

  ipcMain.handle('get-desktop-only', () => !alwaysOnTop)

  ipcMain.handle('set-desktop-only', (_event, flag: boolean) => {
    if (typeof flag !== 'boolean') return
    setAlwaysOnTopState(!flag)
  })

  ipcMain.handle('set-click-through-locked', (_event, flag: boolean) => {
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

  ipcMain.handle('minimize-window', () => {
    mainWindow?.minimize()
  })

  ipcMain.handle('stt-transcribe', async (_event, audioBuffer: ArrayBuffer, url?: string) => {
    const sttUrl = new URL(url || 'http://127.0.0.1:18530/stt')
    const body = Buffer.from(audioBuffer)
    return new Promise<string | null>((resolve) => {
      const req = http.request({
        hostname: sttUrl.hostname, port: sttUrl.port, path: sttUrl.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
      }, (res) => {
        let data = ''
        res.on('data', (chunk: string) => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data).text || null) } catch { resolve(null) }
        })
        res.on('error', () => resolve(null))
      })
      req.on('error', () => resolve(null))
      req.write(body)
      req.end()
    })
  })

  ipcMain.handle('get-doubao-config', () => getDoubaoConfigView())

  ipcMain.handle('save-doubao-config', (_event, input: DoubaoConfigInput) => {
    return getDoubaoConfigView(writeDoubaoConfig(input))
  })

  ipcMain.handle('test-doubao-connection', async (_event, input: DoubaoConfigInput) => {
    const config = writeDoubaoConfig(input)
    return requestDoubao(
      config,
      [{ role: 'user', content: '只回复“连接成功”四个字。' }],
      { maxTokens: 16 },
    )
  })

  ipcMain.handle('doubao-chat', async (event, input: DoubaoChatRequest) => {
    if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) {
      return { ok: false, error: '无效的调用来源' }
    }
    if (
      !input || typeof input.requestId !== 'string' || !input.requestId
      || !Array.isArray(input.messages)
    ) return { ok: false, error: '无效的豆包请求' }

    const controller = new AbortController()
    doubaoRequests.get(input.requestId)?.abort()
    doubaoRequests.set(input.requestId, controller)
    try {
      return await requestDoubao(readDoubaoConfig(), input.messages, {
        signal: controller.signal,
        onDelta: (delta) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('doubao-chat-delta', { requestId: input.requestId, delta })
          }
        },
      })
    } finally {
      if (doubaoRequests.get(input.requestId) === controller) {
        doubaoRequests.delete(input.requestId)
      }
    }
  })

  ipcMain.handle('cancel-doubao-chat', (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return false
    const controller = doubaoRequests.get(requestId)
    controller?.abort()
    return Boolean(controller)
  })

  ipcMain.handle('get-market-config', () => readMarketConfig())

  ipcMain.handle('save-market-config', (_event, input: unknown) => {
    const config = writeMarketConfig(input)
    marketBridge?.restartOwned()
    return config
  })

  ipcMain.handle('test-market-connection', async () => {
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

  ipcMain.handle('set-auto-screenshot-interval', (_event, sec: number) => {
    autoScreenshotInterval = sec
    if (autoScreenshotTimer) setAutoScreenshot(true, sec)
  })

  ipcMain.handle('save-agent-result', async (_event, value: unknown) => {
    if (!value || typeof value !== 'object') return false
    const input = value as { title?: unknown; content?: unknown }
    if (typeof input.content !== 'string' || !input.content || input.content.length > 2_000_000) return false
    const title = typeof input.title === 'string' && input.title.trim()
      ? input.title.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)
      : '麦麦任务结果'
    const options = {
      title: '保存 Agent 结果',
      defaultPath: `${title}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }],
    }
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await fs.promises.writeFile(result.filePath, `# ${title}\n\n${input.content}\n`, 'utf-8')
    return true
  })

  ipcMain.handle('close-window', () => {
    mainWindow?.close()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  marketBridge?.stop()
  marketBridge = null
  stopGlobalCursorPolling()
  globalShortcut.unregisterAll()
  if (tray) { tray.destroy(); tray = null }
})
