import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NativeToolAuditStore } from './native-tool-audit'

describe('native tool audit store', () => {
  let directory = ''
  let store: NativeToolAuditStore

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-tool-audit-'))
    store = new NativeToolAuditStore(path.join(directory, 'audit.json'))
  })

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

  it('persists sanitized execution evidence and clears it', () => {
    const entry = store.append({
      requestId: 'req-1', roleId: 'default', tool: 'open_url',
      summary: '打开 https://example.com', status: 'succeeded',
    })
    expect(entry).toMatchObject({ requestId: 'req-1', tool: 'open_url', status: 'succeeded' })

    const restored = new NativeToolAuditStore(path.join(directory, 'audit.json'))
    expect(restored.list()).toHaveLength(1)
    expect(restored.append({ tool: 'shell', status: 'succeeded' })).toBeNull()
    restored.clear()
    expect(restored.list()).toEqual([])
  })
})
