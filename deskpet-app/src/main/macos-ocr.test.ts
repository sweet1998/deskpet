import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recognizeWithMacosVision, resolveMacosOcrHelper } from './macos-ocr'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('macOS OCR helper', () => {
  it('resolves development and packaged helper paths', () => {
    expect(resolveMacosOcrHelper({
      appPath: '/repo/deskpet-app', resourcesPath: '/Applications/Deskpet/Resources', tempPath: '/tmp', isPackaged: false,
    })).toBe('/repo/deskpet-app/build/native/deskpet-ocr')
    expect(resolveMacosOcrHelper({
      appPath: '/repo/deskpet-app', resourcesPath: '/Applications/Deskpet/Resources', tempPath: '/tmp', isPackaged: true,
    })).toBe('/Applications/Deskpet/Resources/native/deskpet-ocr')
  })

  it('parses helper JSON and removes the temporary source image', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-ocr-test-'))
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-ocr-files-'))
    directories.push(root, temporary)
    const helper = path.join(root, 'build', 'native', 'deskpet-ocr')
    fs.mkdirSync(path.dirname(helper), { recursive: true })
    fs.writeFileSync(helper, '#!/bin/sh\nprintf \'{"ok":true,"text":"识别成功","pages":1,"truncated":false}\\n\'\n')
    fs.chmodSync(helper, 0o755)

    const result = await recognizeWithMacosVision(Buffer.from('fake-image'), 'png', {
      appPath: root,
      resourcesPath: '/unused',
      tempPath: temporary,
      isPackaged: false,
    })

    expect(result).toEqual({ ok: true, text: '识别成功', pages: 1, truncated: false })
    expect(fs.readdirSync(temporary)).toEqual([])
  })

  it('reports a missing packaged helper', async () => {
    await expect(recognizeWithMacosVision(Buffer.from('fake-image'), 'png', {
      appPath: '/unused', resourcesPath: '/missing', tempPath: os.tmpdir(), isPackaged: true,
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining('缺少') })
  })
})
