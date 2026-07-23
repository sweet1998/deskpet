import fs from 'node:fs'
import path from 'node:path'
import type { EncryptionProvider } from './secure-doubao-config'
import type { SecureUserDataReadResult } from '../shared/secure-user-data'

const MAX_JSON_BYTES = 4 * 1024 * 1024

interface EncryptedUserData {
  version: 1
  encryptedData: string
}

export function readSecureUserData(
  filePath: string,
  encryption: EncryptionProvider,
): SecureUserDataReadResult {
  if (!encryption.isEncryptionAvailable()) {
    return { available: false, exists: fs.existsSync(filePath), error: 'macOS 钥匙串当前不可用' }
  }
  if (!fs.existsSync(filePath)) return { available: true, exists: false }
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<EncryptedUserData>
    if (stored.version !== 1 || typeof stored.encryptedData !== 'string') {
      throw new Error('加密数据格式无效')
    }
    const json = encryption.decryptString(Buffer.from(stored.encryptedData, 'base64'))
    return { available: true, exists: true, value: JSON.parse(json) }
  } catch (error) {
    return {
      available: true,
      exists: true,
      error: error instanceof Error ? error.message : '无法读取加密数据',
    }
  }
}

export function writeSecureUserData(
  filePath: string,
  value: unknown,
  encryption: EncryptionProvider,
): boolean {
  if (!encryption.isEncryptionAvailable()) return false
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf-8') > MAX_JSON_BYTES) {
    throw new Error('本地数据超过 4MB，无法继续保存')
  }
  const stored: EncryptedUserData = {
    version: 1,
    encryptedData: encryption.encryptString(json).toString('base64'),
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 })
  fs.renameSync(temporary, filePath)
  return true
}

export function clearSecureUserData(filePath: string): void {
  try { fs.rmSync(filePath, { force: true }) } catch { /* already absent */ }
}
