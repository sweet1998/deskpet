import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getMacosSpeechAuthorizationStatus,
  resolveMacosSttHelper,
  transcribeWithBridge,
  transcribeWithMacos,
} from './macos-stt'

describe('macOS speech recognition helper', () => {
  it('resolves development and packaged helper paths', () => {
    expect(resolveMacosSttHelper({
      appPath: '/repo/deskpet-app', resourcesPath: '/Applications/Deskpet/Resources', tempPath: '/tmp', isPackaged: false,
    })).toBe('/repo/deskpet-app/build/native/deskpet-stt')
    expect(resolveMacosSttHelper({
      appPath: '/repo/deskpet-app', resourcesPath: '/Applications/Deskpet/Resources', tempPath: '/tmp', isPackaged: true,
    })).toBe('/Applications/Deskpet/Resources/native/deskpet-stt')
  })

  it('rejects invalid audio without creating a temporary file', async () => {
    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-stt-test-'))
    await expect(transcribeWithMacos(new ArrayBuffer(4), {
      appPath: tempPath, resourcesPath: tempPath, tempPath, isPackaged: false,
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('无效') })
    expect(fs.readdirSync(tempPath)).toEqual([])
    fs.rmSync(tempPath, { recursive: true, force: true })
  })

  it('reports a missing permission helper without prompting', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-stt-status-'))
    await expect(getMacosSpeechAuthorizationStatus({
      appPath: root, resourcesPath: root, tempPath: root, isPackaged: false,
    })).resolves.toEqual({ helperAvailable: false, status: 'unavailable' })
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('rejects unsafe bridge protocols before sending audio', async () => {
    await expect(transcribeWithBridge(new ArrayBuffer(64), 'file:///tmp/stt'))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining('HTTP') })
  })
})
