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
  sttTranscribe: (audio: ArrayBuffer, url?: string) => Promise<string | null>
}

interface Window {
  electronAPI?: ElectronAPI
}
