import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendDiagnosticEvent, readDiagnosticLogTail, redactDiagnosticText } from './diagnostics'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('diagnostics', () => {
  it('redacts credentials and the local home path', () => {
    const input = 'Authorization=secret Bearer abc.def api_key:another /Users/test/private.log'
    const output = redactDiagnosticText(input, '/Users/test')
    expect(output).not.toContain('secret')
    expect(output).not.toContain('abc.def')
    expect(output).not.toContain('another')
    expect(output).toContain('~/private.log')
  })

  it('records and reads recent diagnostic events', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-diagnostics-'))
    directories.push(directory)
    const filePath = path.join(directory, 'events.jsonl')
    appendDiagnosticEvent(filePath, { type: 'renderer-gone', reason: 'crashed' })
    expect(readDiagnosticLogTail(filePath)).toContain('renderer-gone')
  })
})
