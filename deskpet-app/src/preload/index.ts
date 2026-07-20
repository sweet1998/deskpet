import { contextBridge, ipcRenderer } from 'electron'
import {
  isPetContextMenuCommand,
  type PetContextMenuCommand,
  type PetContextMenuRequest,
} from '../shared/pet-context-menu'
import type { DoubaoChatRequest, DoubaoConfigInput, DoubaoStreamDelta } from '../shared/doubao'
import type { MarketBridgeConfig } from '../shared/market'

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
  sttTranscribe: (audio: ArrayBuffer, url?: string): Promise<string | null> => ipcRenderer.invoke('stt-transcribe', audio, url),
  getDoubaoConfig: () => ipcRenderer.invoke('get-doubao-config'),
  saveDoubaoConfig: (input: DoubaoConfigInput) => ipcRenderer.invoke('save-doubao-config', input),
  testDoubaoConnection: (input: DoubaoConfigInput) => ipcRenderer.invoke('test-doubao-connection', input),
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
})
