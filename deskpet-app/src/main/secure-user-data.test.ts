import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EncryptionProvider } from './secure-doubao-config'
import {
  clearSecureUserData,
  readSecureUserData,
  writeSecureUserData,
} from './secure-user-data'

const encryption: EncryptionProvider = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf-8'),
  decryptString: (value) => value.toString('utf-8').replace(/^encrypted:/, ''),
}

describe('secure user data', () => {
  let directory = ''
  let filePath = ''

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-secure-data-'))
    filePath = path.join(directory, 'chat-data.json')
  })

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

  it('encrypts the complete payload and reads it back', () => {
    expect(writeSecureUserData(filePath, { message: '私人内容' }, encryption)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain('私人内容')
    expect(readSecureUserData(filePath, encryption)).toMatchObject({
      available: true,
      exists: true,
      value: { message: '私人内容' },
    })
  })

  it('does not write plaintext when encryption is unavailable', () => {
    const unavailable = { ...encryption, isEncryptionAvailable: () => false }
    expect(writeSecureUserData(filePath, { message: '私人内容' }, unavailable)).toBe(false)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('removes encrypted data', () => {
    writeSecureUserData(filePath, { message: 'test' }, encryption)
    clearSecureUserData(filePath)
    expect(fs.existsSync(filePath)).toBe(false)
  })
})
