// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('main window startup ordering', () => {
  it('waits for renderer navigation before synchronizing initial state', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf-8')
    const handler = source.indexOf('const handleInitialRendererLoad')
    const navigation = source.indexOf('const rendererLoad')
    const completion = source.indexOf('rendererLoad.then(handleInitialRendererLoad)')

    expect(handler).toBeGreaterThan(-1)
    expect(navigation).toBeGreaterThan(handler)
    expect(completion).toBeGreaterThan(navigation)
  })

  it('registers IPC handlers before creating the renderer window', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf-8')
    const doubaoHandlers = source.indexOf('doubaoIpc.register(ipcMain)')
    const finalHandler = source.indexOf("ipcMain.handle('close-window'")
    const windowCreation = source.lastIndexOf('\n  createWindow()\n')

    expect(doubaoHandlers).toBeGreaterThan(-1)
    expect(finalHandler).toBeGreaterThan(doubaoHandlers)
    expect(windowCreation).toBeGreaterThan(finalHandler)
  })

  it('guards sensitive legacy IPC handlers with the main window sender check', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf-8')
    const guardedHandlers = [
      'set-always-on-top',
      'set-desktop-only',
      'set-click-through-locked',
      'minimize-window',
      'check-for-updates',
      'save-market-config',
      'test-market-connection',
      'close-window',
    ]

    for (const channel of guardedHandlers) {
      const start = source.indexOf(`ipcMain.handle('${channel}'`)
      const end = source.indexOf('\n  ipcMain.handle(', start + 1)
      const handler = source.slice(start, end === -1 ? undefined : end)
      expect(start, `${channel} handler`).toBeGreaterThan(-1)
      expect(handler, `${channel} sender guard`).toContain('isMainWindowSender(event)')
    }
  })
})
