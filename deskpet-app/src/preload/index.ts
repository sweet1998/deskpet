import { contextBridge, ipcRenderer } from 'electron'
import {
  isPetContextMenuCommand,
  type PetContextMenuCommand,
  type PetContextMenuRequest,
} from '../shared/pet-context-menu'
import type {
  DoubaoCapabilityReport,
  DoubaoChatRequest,
  DoubaoConfigInput,
  DoubaoStreamDelta,
} from '../shared/doubao'
import type { MarketBridgeConfig } from '../shared/market'
import type {
  SecureUserDataNamespace,
  SecureUserDataReadResult,
} from '../shared/secure-user-data'
import type { SttTranscriptionResult, VoicePermissionStatus } from '../shared/voice'
import type { DesktopBackendAccess } from '../shared/backend'
import type {
  NativeFileExtractionInput,
  NativeFileExtractionResult,
  NativeReminder,
  NativeReminderInput,
  NativeToolAuditEntry,
  NativeToolAuditInput,
  NativeToolPlanningRequest,
  NativeToolPlanningResult,
} from '../shared/native-tools'

interface GlobalCursorPosition {
  screenX: number
  screenY: number
  windowX: number
  windowY: number
  x: number
  y: number
}

contextBridge.exposeInMainWorld('electronAPI', {
  dragWindow: (dx: number, dy: number) => ipcRenderer.invoke('drag-window', { dx, dy }),
  setPetWindowLayout: (request: {
    mode: 'compact' | 'settings'
    petWidth: number
    petHeight: number
    settingsWidth: number
    settingsHeight: number
  }): Promise<{
    petX: number
    petY: number
    settingsX: number
    settingsY: number
    settingsWidth: number
    settingsHeight: number
  } | null> => ipcRenderer.invoke('set-pet-window-layout', request),
  onPetWindowLayoutChanged: (callback: (layout: {
    petX: number
    petY: number
    settingsX: number
    settingsY: number
    settingsWidth: number
    settingsHeight: number
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, layout: {
      petX: number
      petY: number
      settingsX: number
      settingsY: number
      settingsWidth: number
      settingsHeight: number
    }) => callback(layout)
    ipcRenderer.on('pet-window-layout-changed', listener)
    return () => ipcRenderer.removeListener('pet-window-layout-changed', listener)
  },
  setPetHitTestInteractive: (interactive: boolean): Promise<void> => ipcRenderer.invoke('set-pet-hit-test-interactive', interactive),
  setAlwaysOnTop: (flag: boolean) => ipcRenderer.invoke('set-always-on-top', flag),
  getDesktopOnly: (): Promise<boolean> => ipcRenderer.invoke('get-desktop-only'),
  setDesktopOnly: (flag: boolean): Promise<void> => ipcRenderer.invoke('set-desktop-only', flag),
  onDesktopOnlyChanged: (callback: (flag: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, flag: boolean) => callback(flag)
    ipcRenderer.on('desktop-only-changed', listener)
    return () => ipcRenderer.removeListener('desktop-only-changed', listener)
  },
  setClickThroughLocked: (flag: boolean) => ipcRenderer.invoke('set-click-through-locked', flag),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  showPetContextMenu: (request: PetContextMenuRequest): Promise<void> =>
    ipcRenderer.invoke('show-pet-context-menu', request),
  onPetContextMenuCommand: (callback: (command: PetContextMenuCommand) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: unknown) => {
      if (isPetContextMenuCommand(command)) callback(command)
    }
    ipcRenderer.on('pet-context-command', listener)
    return () => ipcRenderer.removeListener('pet-context-command', listener)
  },
  onGlobalCursorPosition: (callback: (position: GlobalCursorPosition) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, position: GlobalCursorPosition) => callback(position)
    ipcRenderer.on('global-cursor-position', listener)
    return () => ipcRenderer.removeListener('global-cursor-position', listener)
  },
  onResetModelView: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('reset-model-view', listener)
    return () => ipcRenderer.removeListener('reset-model-view', listener)
  },
  onSetHoverFade: (callback: (enabled: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean) => callback(enabled)
    ipcRenderer.on('set-hover-fade', listener)
    return () => ipcRenderer.removeListener('set-hover-fade', listener)
  },
  onScreenshotCaptured: (callback: (base64: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, base64: string) => callback(base64)
    ipcRenderer.on('screenshot-captured', listener)
    return () => ipcRenderer.removeListener('screenshot-captured', listener)
  },
  setAutoScreenshotInterval: (sec: number) => ipcRenderer.invoke('set-auto-screenshot-interval', sec),
  captureScreen: (): Promise<string | null> => ipcRenderer.invoke('capture-screen'),
  captureScreenRegion: (): Promise<string | null> => ipcRenderer.invoke('capture-screen-region'),
  extractNativeFile: (input: NativeFileExtractionInput): Promise<NativeFileExtractionResult> =>
    ipcRenderer.invoke('extract-native-file', input),
  listNativeReminders: (): Promise<NativeReminder[]> => ipcRenderer.invoke('list-native-reminders'),
  planNativeTools: (input: NativeToolPlanningRequest): Promise<NativeToolPlanningResult> =>
    ipcRenderer.invoke('plan-native-tools', input),
  createNativeReminder: (input: NativeReminderInput): Promise<NativeReminder | { error: string } | null> =>
    ipcRenderer.invoke('create-native-reminder', input),
  cancelNativeReminder: (id: string): Promise<boolean> => ipcRenderer.invoke('cancel-native-reminder', id),
  clearNativeReminders: (): Promise<boolean> => ipcRenderer.invoke('clear-native-reminders'),
  appendNativeToolAudit: (input: NativeToolAuditInput): Promise<NativeToolAuditEntry | null> =>
    ipcRenderer.invoke('append-native-tool-audit', input),
  listNativeToolAudit: (): Promise<NativeToolAuditEntry[]> => ipcRenderer.invoke('list-native-tool-audit'),
  clearNativeToolAudit: (): Promise<boolean> => ipcRenderer.invoke('clear-native-tool-audit'),
  onNativeReminderTriggered: (callback: (reminder: NativeReminder) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, reminder: NativeReminder) => callback(reminder)
    ipcRenderer.on('native-reminder-triggered', listener)
    return () => ipcRenderer.removeListener('native-reminder-triggered', listener)
  },
  writeNativeClipboard: (text: string): Promise<boolean> => ipcRenderer.invoke('write-native-clipboard', text),
  openNativeUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('open-native-url', url),
  revealNativePath: (targetPath: string): Promise<boolean> => ipcRenderer.invoke('reveal-native-path', targetPath),
  sttTranscribe: (audio: ArrayBuffer, url?: string): Promise<SttTranscriptionResult> =>
    ipcRenderer.invoke('stt-transcribe', audio, url),
  getVoicePermissionStatus: (): Promise<VoicePermissionStatus | null> =>
    ipcRenderer.invoke('get-voice-permission-status'),
  getDoubaoConfig: () => ipcRenderer.invoke('get-doubao-config'),
  saveDoubaoConfig: (input: DoubaoConfigInput) => ipcRenderer.invoke('save-doubao-config', input),
  clearDoubaoConfig: (): Promise<boolean> => ipcRenderer.invoke('clear-doubao-config'),
  readSecureUserData: (namespace: SecureUserDataNamespace): Promise<SecureUserDataReadResult> =>
    ipcRenderer.invoke('read-secure-user-data', namespace),
  writeSecureUserData: (namespace: SecureUserDataNamespace, value: unknown): Promise<boolean> =>
    ipcRenderer.invoke('write-secure-user-data', namespace, value),
  clearSecureUserData: (namespace: SecureUserDataNamespace): Promise<boolean> =>
    ipcRenderer.invoke('clear-secure-user-data', namespace),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  openProductDocument: (kind: 'privacy' | 'terms'): Promise<boolean> =>
    ipcRenderer.invoke('open-product-document', kind),
  getBackendAccess: (): Promise<DesktopBackendAccess | null> => ipcRenderer.invoke('get-backend-access'),
  getSystemIdleTime: (): Promise<number> => ipcRenderer.invoke('get-system-idle-time'),
  checkForUpdates: (): Promise<boolean> => ipcRenderer.invoke('check-for-updates'),
  testDoubaoConnection: (input: DoubaoConfigInput) => ipcRenderer.invoke('test-doubao-connection', input),
  detectDoubaoCapabilities: (input: DoubaoConfigInput): Promise<DoubaoCapabilityReport> =>
    ipcRenderer.invoke('detect-doubao-capabilities', input),
  doubaoChat: (input: DoubaoChatRequest) => ipcRenderer.invoke('doubao-chat', input),
  onDoubaoChatDelta: (callback: (event: DoubaoStreamDelta) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: DoubaoStreamDelta) => callback(value)
    ipcRenderer.on('doubao-chat-delta', listener)
    return () => ipcRenderer.removeListener('doubao-chat-delta', listener)
  },
  cancelDoubaoChat: (requestId: string): Promise<boolean> => ipcRenderer.invoke('cancel-doubao-chat', requestId),
  getMarketConfig: (): Promise<MarketBridgeConfig> => ipcRenderer.invoke('get-market-config'),
  saveMarketConfig: (input: MarketBridgeConfig): Promise<MarketBridgeConfig> => ipcRenderer.invoke('save-market-config', input),
  testMarketConnection: () => ipcRenderer.invoke('test-market-connection'),
  getMarketContext: (query: string) => ipcRenderer.invoke('get-market-context', query),
  saveAgentResult: (value: { title: string; content: string }): Promise<boolean> =>
    ipcRenderer.invoke('save-agent-result', value),
  exportConversation: (value: { title: string; content: string }): Promise<boolean> =>
    ipcRenderer.invoke('export-conversation', value),
  exportDiagnostics: (): Promise<boolean> => ipcRenderer.invoke('export-diagnostics'),
})
