/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface GlobalCursorPosition {
  screenX: number
  screenY: number
  windowX: number
  windowY: number
  x: number
  y: number
}

interface PetWindowLayoutResult {
  petX: number
  petY: number
  settingsX: number
  settingsY: number
  settingsWidth: number
  settingsHeight: number
}

interface ElectronAPI {
  dragWindow: (dx: number, dy: number) => Promise<void>
  setPetWindowLayout: (request: {
    mode: 'compact' | 'settings'
    petWidth: number
    petHeight: number
    settingsWidth: number
    settingsHeight: number
  }) => Promise<PetWindowLayoutResult | null>
  onPetWindowLayoutChanged: (callback: (layout: PetWindowLayoutResult) => void) => () => void
  setPetHitTestInteractive: (interactive: boolean) => Promise<void>
  setAlwaysOnTop: (flag: boolean) => Promise<void>
  getDesktopOnly: () => Promise<boolean>
  setDesktopOnly: (flag: boolean) => Promise<void>
  onDesktopOnlyChanged: (callback: (flag: boolean) => void) => () => void
  setClickThroughLocked: (flag: boolean) => Promise<void>
  minimizeWindow: () => Promise<void>
  closeWindow: () => Promise<void>
  showPetContextMenu: (request: import('../shared/pet-context-menu').PetContextMenuRequest) => Promise<void>
  onPetContextMenuCommand: (callback: (command: import('../shared/pet-context-menu').PetContextMenuCommand) => void) => () => void
  onGlobalCursorPosition: (callback: (position: GlobalCursorPosition) => void) => () => void
  onResetModelView: (callback: () => void) => () => void
  onSetHoverFade: (callback: (enabled: boolean) => void) => () => void
  onScreenshotCaptured: (callback: (base64: string) => void) => () => void
  setAutoScreenshotInterval: (sec: number) => void
  captureScreen: () => Promise<string | null>
  captureScreenRegion: () => Promise<string | null>
  extractNativeFile: (input: import('../shared/native-tools').NativeFileExtractionInput) => Promise<import('../shared/native-tools').NativeFileExtractionResult>
  listNativeReminders: () => Promise<import('../shared/native-tools').NativeReminder[]>
  planNativeTools: (input: import('../shared/native-tools').NativeToolPlanningRequest) => Promise<import('../shared/native-tools').NativeToolPlanningResult>
  createNativeReminder: (input: import('../shared/native-tools').NativeReminderInput) => Promise<import('../shared/native-tools').NativeReminder | { error: string } | null>
  cancelNativeReminder: (id: string) => Promise<boolean>
  clearNativeReminders: () => Promise<boolean>
  appendNativeToolAudit: (input: import('../shared/native-tools').NativeToolAuditInput) => Promise<import('../shared/native-tools').NativeToolAuditEntry | null>
  listNativeToolAudit: () => Promise<import('../shared/native-tools').NativeToolAuditEntry[]>
  clearNativeToolAudit: () => Promise<boolean>
  onNativeReminderTriggered: (callback: (reminder: import('../shared/native-tools').NativeReminder) => void) => () => void
  writeNativeClipboard: (text: string) => Promise<boolean>
  openNativeUrl: (url: string) => Promise<boolean>
  revealNativePath: (targetPath: string) => Promise<boolean>
  sttTranscribe: (audio: ArrayBuffer, url?: string) => Promise<import('../shared/voice').SttTranscriptionResult>
  getVoicePermissionStatus: () => Promise<import('../shared/voice').VoicePermissionStatus | null>
  getDoubaoConfig: () => Promise<import('../shared/doubao').DoubaoConfigView>
  saveDoubaoConfig: (input: import('../shared/doubao').DoubaoConfigInput) => Promise<import('../shared/doubao').DoubaoConfigView>
  clearDoubaoConfig: () => Promise<boolean>
  readSecureUserData: (namespace: import('../shared/secure-user-data').SecureUserDataNamespace) => Promise<import('../shared/secure-user-data').SecureUserDataReadResult>
  writeSecureUserData: (namespace: import('../shared/secure-user-data').SecureUserDataNamespace, value: unknown) => Promise<boolean>
  clearSecureUserData: (namespace: import('../shared/secure-user-data').SecureUserDataNamespace) => Promise<boolean>
  getAppVersion: () => Promise<string>
  openProductDocument: (kind: 'privacy' | 'terms') => Promise<boolean>
  getBackendAccess: () => Promise<import('../shared/backend').DesktopBackendAccess | null>
  getSystemIdleTime: () => Promise<number>
  checkForUpdates: () => Promise<boolean>
  testDoubaoConnection: (input: import('../shared/doubao').DoubaoConfigInput) => Promise<import('../shared/doubao').DoubaoResult>
  detectDoubaoCapabilities: (input: import('../shared/doubao').DoubaoConfigInput) => Promise<import('../shared/doubao').DoubaoCapabilityReport>
  doubaoChat: (input: import('../shared/doubao').DoubaoChatRequest) => Promise<import('../shared/doubao').DoubaoResult>
  onDoubaoChatDelta: (callback: (event: import('../shared/doubao').DoubaoStreamDelta) => void) => () => void
  cancelDoubaoChat: (requestId: string) => Promise<boolean>
  getMarketConfig: () => Promise<import('../shared/market').MarketBridgeConfig>
  saveMarketConfig: (input: import('../shared/market').MarketBridgeConfig) => Promise<import('../shared/market').MarketBridgeConfig>
  testMarketConnection: () => Promise<import('../shared/market').MarketBridgeHealth>
  getMarketContext: (query: string) => Promise<import('../shared/market').MarketContextResult>
  saveAgentResult: (value: { title: string; content: string }) => Promise<boolean>
  exportConversation: (value: { title: string; content: string }) => Promise<boolean>
  exportDiagnostics: () => Promise<boolean>
}

interface Window {
  electronAPI?: ElectronAPI
}
