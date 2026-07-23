import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const MAX_OCR_BYTES = 12 * 1024 * 1024

export interface MacosOcrPaths {
  appPath: string
  resourcesPath: string
  tempPath: string
  isPackaged: boolean
}

export interface MacosOcrResult {
  ok: boolean
  text?: string
  pages?: number
  truncated?: boolean
  error?: string
}

export function resolveMacosOcrHelper(paths: MacosOcrPaths): string {
  return paths.isPackaged
    ? path.join(paths.resourcesPath, 'native', 'deskpet-ocr')
    : path.join(paths.appPath, 'build', 'native', 'deskpet-ocr')
}

export async function recognizeWithMacosVision(
  value: Buffer,
  extension: string,
  paths: MacosOcrPaths,
): Promise<MacosOcrResult> {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > MAX_OCR_BYTES) {
    return { ok: false, error: 'OCR 文件无效或过大' }
  }
  const helper = resolveMacosOcrHelper(paths)
  if (!fs.existsSync(helper)) return { ok: false, error: '安装包缺少 macOS 文字识别组件' }
  const safeExtension = /^[a-z0-9]{2,5}$/i.test(extension) ? extension.toLowerCase() : 'img'
  const temporary = path.join(paths.tempPath, `maimai-ocr-${Date.now()}-${process.pid}.${safeExtension}`)
  try {
    await fs.promises.writeFile(temporary, value, { mode: 0o600 })
    return await new Promise((resolve) => {
      execFile(helper, [temporary, '20'], { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: stderr.trim() || (error.killed ? 'OCR 识别超时' : error.message) })
          return
        }
        try {
          const result = JSON.parse(stdout) as MacosOcrResult
          const text = typeof result.text === 'string' ? result.text.trim() : ''
          resolve(text
            ? {
                ok: true,
                text,
                pages: Number.isFinite(result.pages) ? result.pages : 1,
                truncated: result.truncated === true,
              }
            : { ok: false, error: '没有识别到可读文字' })
        } catch {
          resolve({ ok: false, error: 'macOS OCR 返回格式无效' })
        }
      })
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无法启动 macOS 文字识别' }
  } finally {
    try { await fs.promises.rm(temporary, { force: true }) } catch { /* already absent */ }
  }
}
