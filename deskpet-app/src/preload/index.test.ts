import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PetContextMenuCommand,
  PetContextMenuRequest,
} from '../shared/pet-context-menu'
import type { DoubaoCapabilityReport, DoubaoStreamDelta } from '../shared/doubao'
import type { NativeReminder, NativeToolAuditEntry, NativeToolAuditInput } from '../shared/native-tools'
import type { SecureUserDataReadResult } from '../shared/secure-user-data'

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}))

import './index'

interface ExposedElectronAPI {
  showPetContextMenu: (request: PetContextMenuRequest) => Promise<void>
  onPetContextMenuCommand: (
    callback: (command: PetContextMenuCommand) => void,
  ) => () => void
  onDoubaoChatDelta: (callback: (event: DoubaoStreamDelta) => void) => () => void
  exportConversation: (value: { title: string; content: string }) => Promise<boolean>
  exportDiagnostics: () => Promise<boolean>
  captureScreen: () => Promise<string | null>
  captureScreenRegion: () => Promise<string | null>
  detectDoubaoCapabilities: (value: { apiKey?: string; model?: string }) => Promise<DoubaoCapabilityReport>
  clearDoubaoConfig: () => Promise<boolean>
  getAppVersion: () => Promise<string>
  openProductDocument: (kind: 'privacy' | 'terms') => Promise<boolean>
  getBackendAccess: () => Promise<{ url: string; token: string } | null>
  getSystemIdleTime: () => Promise<number>
  checkForUpdates: () => Promise<boolean>
  appendNativeToolAudit: (input: NativeToolAuditInput) => Promise<NativeToolAuditEntry | null>
  listNativeToolAudit: () => Promise<NativeToolAuditEntry[]>
  clearNativeToolAudit: () => Promise<boolean>
  createNativeReminder: (value: { title: string; body: string; dueAt: number }) => Promise<NativeReminder | { error: string } | null>
  planNativeTools: (value: { text: string }) => Promise<import('../shared/native-tools').NativeToolPlanningResult>
  getVoicePermissionStatus: () => Promise<import('../shared/voice').VoicePermissionStatus | null>
  onNativeReminderTriggered: (callback: (reminder: NativeReminder) => void) => () => void
  readSecureUserData: (namespace: 'chat' | 'agent') => Promise<SecureUserDataReadResult>
  writeSecureUserData: (namespace: 'chat' | 'agent', value: unknown) => Promise<boolean>
  clearSecureUserData: (namespace: 'chat' | 'agent') => Promise<boolean>
}

const electronAPI = electronMocks.exposeInMainWorld.mock.calls[0][1] as ExposedElectronAPI

describe('pet context menu preload API', () => {
  beforeEach(() => {
    electronMocks.invoke.mockClear()
    electronMocks.on.mockClear()
    electronMocks.removeListener.mockClear()
  })

  it('forwards the pet context menu request to the main process', () => {
    const request: PetContextMenuRequest = {
      emotions: ['happy'],
      actions: ['jump'],
      currentRole: 'default',
    }

    electronAPI.showPetContextMenu(request)

    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'show-pet-context-menu',
      request,
    )
  })

  it('filters commands and removes the registered listener on unsubscribe', () => {
    const callback = vi.fn()
    const unsubscribe = electronAPI.onPetContextMenuCommand(callback)

    expect(electronMocks.on).toHaveBeenCalledWith(
      'pet-context-command',
      expect.any(Function),
    )
    const listener = electronMocks.on.mock.calls[0][1] as (
      event: unknown,
      command: unknown,
    ) => void

    listener({}, { type: 'other' })
    expect(callback).not.toHaveBeenCalled()

    listener({}, { type: 'emotion', id: 'happy' })
    expect(callback).toHaveBeenCalledWith({ type: 'emotion', id: 'happy' })

    unsubscribe()
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      'pet-context-command',
      listener,
    )
  })

  it('forwards and removes the Doubao stream listener', () => {
    const callback = vi.fn()
    const unsubscribe = electronAPI.onDoubaoChatDelta(callback)
    const listener = electronMocks.on.mock.calls[0][1] as (event: unknown, value: DoubaoStreamDelta) => void

    listener({}, { requestId: 'req-1', delta: '第一段' })
    expect(callback).toHaveBeenCalledWith({ requestId: 'req-1', delta: '第一段' })

    unsubscribe()
    expect(electronMocks.removeListener).toHaveBeenCalledWith('doubao-chat-delta', listener)
  })

  it('forwards conversation exports to the main process', () => {
    const value = { title: '一段会话', content: '# 一段会话' }

    electronAPI.exportConversation(value)

    expect(electronMocks.invoke).toHaveBeenCalledWith('export-conversation', value)
    electronAPI.exportDiagnostics()
    expect(electronMocks.invoke).toHaveBeenCalledWith('export-diagnostics')
  })

  it('forwards native screen capture and reminder creation', () => {
    const reminder = { title: '麦麦提醒', body: '开会', dueAt: 123456 }

    electronAPI.captureScreen()
    electronAPI.captureScreenRegion()
    electronAPI.createNativeReminder(reminder)
    electronAPI.planNativeTools({ text: '半小时后叫我起来活动' })
    electronAPI.getVoicePermissionStatus()

    expect(electronMocks.invoke).toHaveBeenCalledWith('capture-screen')
    expect(electronMocks.invoke).toHaveBeenCalledWith('capture-screen-region')
    expect(electronMocks.invoke).toHaveBeenCalledWith('create-native-reminder', reminder)
    expect(electronMocks.invoke).toHaveBeenCalledWith('plan-native-tools', { text: '半小时后叫我起来活动' })
    expect(electronMocks.invoke).toHaveBeenCalledWith('get-voice-permission-status')
  })

  it('forwards Doubao capability detection', () => {
    const input = { apiKey: 'secret', model: 'ep-vision' }

    electronAPI.detectDoubaoCapabilities(input)

    expect(electronMocks.invoke).toHaveBeenCalledWith('detect-doubao-capabilities', input)
  })

  it('forwards secure credential deletion', () => {
    electronAPI.clearDoubaoConfig()
    expect(electronMocks.invoke).toHaveBeenCalledWith('clear-doubao-config')
  })

  it('forwards encrypted user data operations', () => {
    const value = { version: 1, conversations: {} }
    electronAPI.readSecureUserData('chat')
    electronAPI.writeSecureUserData('chat', value)
    electronAPI.clearSecureUserData('chat')

    expect(electronMocks.invoke).toHaveBeenCalledWith('read-secure-user-data', 'chat')
    expect(electronMocks.invoke).toHaveBeenCalledWith('write-secure-user-data', 'chat', value)
    expect(electronMocks.invoke).toHaveBeenCalledWith('clear-secure-user-data', 'chat')
  })

  it('forwards app version and update checks', () => {
    electronAPI.getAppVersion()
    electronAPI.getBackendAccess()
    electronAPI.getSystemIdleTime()
    electronAPI.checkForUpdates()
    electronAPI.openProductDocument('privacy')

    expect(electronMocks.invoke).toHaveBeenCalledWith('get-app-version')
    expect(electronMocks.invoke).toHaveBeenCalledWith('get-backend-access')
    expect(electronMocks.invoke).toHaveBeenCalledWith('get-system-idle-time')
    expect(electronMocks.invoke).toHaveBeenCalledWith('check-for-updates')
    expect(electronMocks.invoke).toHaveBeenCalledWith('open-product-document', 'privacy')
  })

  it('forwards native tool audit operations', () => {
    const input: NativeToolAuditInput = {
      requestId: 'req-1', roleId: 'default', tool: 'open_url', summary: '打开网页', status: 'succeeded',
    }
    electronAPI.appendNativeToolAudit(input)
    electronAPI.listNativeToolAudit()
    electronAPI.clearNativeToolAudit()

    expect(electronMocks.invoke).toHaveBeenCalledWith('append-native-tool-audit', input)
    expect(electronMocks.invoke).toHaveBeenCalledWith('list-native-tool-audit')
    expect(electronMocks.invoke).toHaveBeenCalledWith('clear-native-tool-audit')
  })

  it('forwards and removes native reminder events', () => {
    const callback = vi.fn()
    const unsubscribe = electronAPI.onNativeReminderTriggered(callback)
    const listener = electronMocks.on.mock.calls[0][1] as (event: unknown, reminder: NativeReminder) => void
    const reminder: NativeReminder = {
      id: 'reminder-1', title: '麦麦提醒', body: '喝水', dueAt: 123, createdAt: 1, status: 'delivered',
    }

    listener({}, reminder)

    expect(callback).toHaveBeenCalledWith(reminder)
    unsubscribe()
    expect(electronMocks.removeListener).toHaveBeenCalledWith('native-reminder-triggered', listener)
  })
})
