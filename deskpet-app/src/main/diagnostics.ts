import fs from 'node:fs'
import path from 'node:path'

const MAX_DIAGNOSTIC_LOG_BYTES = 64 * 1024

export function redactDiagnosticText(value: string, homePath = ''): string {
  let output = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  if (homePath) output = output.split(homePath).join('~')
  return output
}

export function readDiagnosticLogTail(filePath: string, homePath = ''): string {
  try {
    const stat = fs.statSync(filePath)
    const start = Math.max(0, stat.size - MAX_DIAGNOSTIC_LOG_BYTES)
    const fd = fs.openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      return redactDiagnosticText(buffer.toString('utf-8'), homePath)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

export function appendDiagnosticEvent(filePath: string, event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } catch { /* diagnostics must not crash the app */ }
}
