import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearSecureDoubaoConfig,
  readSecureDoubaoConfig,
  writeSecureDoubaoConfig,
  type EncryptionProvider,
} from './secure-doubao-config'

const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf-8'),
  decryptString: (value) => value.toString('utf-8').replace(/^encrypted:/, ''),
}

describe('secure Doubao config', () => {
  let directory = ''
  let filePath = ''

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-secure-config-'))
    filePath = path.join(directory, 'doubao-config.json')
  })

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

  it('stores the API key as encrypted base64 instead of plaintext', () => {
    writeSecureDoubaoConfig(filePath, { apiKey: 'secret-key', model: 'ep-test' }, encryption)

    const raw = fs.readFileSync(filePath, 'utf-8')
    expect(raw).not.toContain('secret-key')
    expect(JSON.parse(raw)).toMatchObject({ version: 2, model: 'ep-test' })
    expect(readSecureDoubaoConfig(filePath, encryption)).toEqual({ apiKey: 'secret-key', model: 'ep-test' })
  })

  it('migrates a legacy plaintext config on first read', () => {
    fs.writeFileSync(filePath, JSON.stringify({ apiKey: 'legacy-key', model: 'ep-old' }))

    expect(readSecureDoubaoConfig(filePath, encryption)).toEqual({ apiKey: 'legacy-key', model: 'ep-old' })
    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain('legacy-key')
  })

  it('refuses to persist a new key without system encryption', () => {
    const unavailable = { ...encryption, isEncryptionAvailable: () => false }

    expect(() => writeSecureDoubaoConfig(
      filePath,
      { apiKey: 'secret-key', model: 'ep-test' },
      unavailable,
    )).toThrow('钥匙串')
  })

  it('clears the stored credential file', () => {
    writeSecureDoubaoConfig(filePath, { apiKey: 'secret-key', model: 'ep-test' }, encryption)
    clearSecureDoubaoConfig(filePath)
    expect(fs.existsSync(filePath)).toBe(false)
  })
})
