import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import type { SpeechAuthorizationStatus, SttTranscriptionResult } from '../shared/voice'

const MAX_AUDIO_BYTES = 25 * 1024 * 1024

export interface MacosSttPaths {
  appPath: string
  resourcesPath: string
  tempPath: string
  isPackaged: boolean
}

export function resolveMacosSttHelper(paths: MacosSttPaths): string {
  return paths.isPackaged
    ? path.join(paths.resourcesPath, 'native', 'deskpet-stt')
    : path.join(paths.appPath, 'build', 'native', 'deskpet-stt')
}

export async function getMacosSpeechAuthorizationStatus(
  paths: MacosSttPaths,
): Promise<{ helperAvailable: boolean; status: SpeechAuthorizationStatus }> {
  const helper = resolveMacosSttHelper(paths)
  if (!fs.existsSync(helper)) return { helperAvailable: false, status: 'unavailable' }
  return await new Promise((resolve) => {
    execFile(helper, ['--status'], { timeout: 5_000, maxBuffer: 4096 }, (error, stdout) => {
      const status = stdout.trim() as SpeechAuthorizationStatus
      const allowed: SpeechAuthorizationStatus[] = [
        'authorized', 'denied', 'restricted', 'not-determined', 'unknown',
      ]
      resolve({
        helperAvailable: true,
        status: !error && allowed.includes(status) ? status : 'unknown',
      })
    })
  })
}

function safeAudioBuffer(value: ArrayBuffer): Buffer | null {
  if (!(value instanceof ArrayBuffer) || value.byteLength < 44 || value.byteLength > MAX_AUDIO_BYTES) return null
  return Buffer.from(value)
}

export async function transcribeWithMacos(
  audio: ArrayBuffer,
  paths: MacosSttPaths,
): Promise<SttTranscriptionResult> {
  const body = safeAudioBuffer(audio)
  if (!body) return { ok: false, error: '录音数据无效或过大' }
  const helper = resolveMacosSttHelper(paths)
  if (!fs.existsSync(helper)) return { ok: false, error: '安装包缺少 macOS 语音识别组件' }
  const audioPath = path.join(paths.tempPath, `maimai-stt-${Date.now()}-${process.pid}.wav`)
  try {
    await fs.promises.writeFile(audioPath, body, { mode: 0o600 })
    return await new Promise((resolve) => {
      execFile(helper, [audioPath, 'zh-CN'], {
        timeout: 70_000,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        const text = stdout.trim()
        if (!error && text) {
          resolve({ ok: true, text, source: 'macos' })
          return
        }
        resolve({
          ok: false,
          error: stderr.trim() || (error?.killed ? '语音识别超时' : error?.message) || '没有识别到清晰语音',
        })
      })
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无法启动 macOS 语音识别' }
  } finally {
    try { await fs.promises.rm(audioPath, { force: true }) } catch { /* already absent */ }
  }
}

export async function transcribeWithBridge(
  audio: ArrayBuffer,
  value: string,
): Promise<SttTranscriptionResult> {
  const body = safeAudioBuffer(audio)
  if (!body) return { ok: false, error: '录音数据无效或过大' }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, error: 'STT Bridge 地址无效' }
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, error: 'STT Bridge 只支持 HTTP 或 HTTPS' }
  }
  return await new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http
    const request = client.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
      },
    }, (response) => {
      let data = ''
      response.setEncoding('utf-8')
      response.on('data', (chunk) => { data += chunk.slice(0, 200_000 - data.length) })
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          resolve({ ok: false, error: `STT Bridge 返回 HTTP ${response.statusCode || 0}` })
          return
        }
        try {
          const text = String(JSON.parse(data).text || '').trim()
          resolve(text
            ? { ok: true, text, source: 'bridge' }
            : { ok: false, error: 'STT Bridge 没有返回文字' })
        } catch {
          resolve({ ok: false, error: 'STT Bridge 返回格式无效' })
        }
      })
    })
    request.setTimeout(45_000, () => request.destroy(new Error('STT Bridge 请求超时')))
    request.on('error', (error) => resolve({ ok: false, error: error.message }))
    request.end(body)
  })
}
