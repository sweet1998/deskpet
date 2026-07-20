import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PetContextMenuCommand,
  PetContextMenuRequest,
} from '../shared/pet-context-menu'
import type { DoubaoStreamDelta } from '../shared/doubao'

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
})
