import fs from 'fs'
import path from 'path'
import { normalizeDoubaoConfig, type StoredDoubaoConfig } from './doubao-client'
import type { DoubaoConfigInput } from '../shared/doubao'

export interface EncryptionProvider {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface EncryptedDoubaoConfig {
  version: 2
  model: string
  encryptedApiKey?: string
}

function writeEncryptedConfig(
  filePath: string,
  config: StoredDoubaoConfig,
  encryption: EncryptionProvider,
): void {
  if (config.apiKey && !encryption.isEncryptionAvailable()) {
    throw new Error('macOS 钥匙串当前不可用，无法安全保存 API Key')
  }
  const stored: EncryptedDoubaoConfig = {
    version: 2,
    model: config.model,
    ...(config.apiKey ? {
      encryptedApiKey: encryption.encryptString(config.apiKey).toString('base64'),
    } : {}),
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(stored, null, 2), { mode: 0o600 })
}

export function readSecureDoubaoConfig(
  filePath: string,
  encryption: EncryptionProvider,
): StoredDoubaoConfig {
  try {
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    if (stored.version === 2) {
      const model = typeof stored.model === 'string' ? stored.model.trim().slice(0, 200) : ''
      if (typeof stored.encryptedApiKey !== 'string' || !stored.encryptedApiKey) {
        return { apiKey: '', model }
      }
      if (!encryption.isEncryptionAvailable()) return { apiKey: '', model }
      try {
        const apiKey = encryption.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
        return normalizeDoubaoConfig({ apiKey, model })
      } catch {
        return { apiKey: '', model }
      }
    }

    const legacy = normalizeDoubaoConfig(stored)
    if (legacy.apiKey && encryption.isEncryptionAvailable()) {
      writeEncryptedConfig(filePath, legacy, encryption)
    }
    return legacy
  } catch {
    return { apiKey: '', model: '' }
  }
}

export function writeSecureDoubaoConfig(
  filePath: string,
  input: DoubaoConfigInput,
  encryption: EncryptionProvider,
): StoredDoubaoConfig {
  const config = normalizeDoubaoConfig(input, readSecureDoubaoConfig(filePath, encryption))
  writeEncryptedConfig(filePath, config, encryption)
  return config
}

export function clearSecureDoubaoConfig(filePath: string): void {
  try { fs.rmSync(filePath, { force: true }) } catch { /* already absent */ }
}
