import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  return {
    handlers,
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
    checkForUpdates: vi.fn().mockResolvedValue({}),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
    updater: {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler)
      }),
    },
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: true },
  dialog: { showMessageBox: mocks.showMessageBox },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    ...mocks.updater,
    checkForUpdates: mocks.checkForUpdates,
    downloadUpdate: mocks.downloadUpdate,
    quitAndInstall: mocks.quitAndInstall,
  },
}))

import { checkForUpdates, configureAutoUpdater, stopAutoUpdater } from './updater'

describe('desktop auto updater', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.showMessageBox.mockResolvedValue({ response: 0 })
    mocks.checkForUpdates.mockResolvedValue({})
    mocks.downloadUpdate.mockResolvedValue([])
    mocks.handlers.clear()
  })

  afterEach(() => {
    stopAutoUpdater()
    vi.useRealTimers()
  })

  it('checks manually and asks before downloading and installing', async () => {
    configureAutoUpdater(() => null)
    await expect(checkForUpdates(true)).resolves.toBe(true)

    await mocks.handlers.get('update-available')?.({ version: '0.4.0' })
    expect(mocks.downloadUpdate).toHaveBeenCalledOnce()

    await mocks.handlers.get('update-downloaded')?.({ version: '0.4.0' })
    expect(mocks.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})
