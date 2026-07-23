import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type {
  NativeToolAuditEntry,
  NativeToolAuditInput,
  NativeToolAuditStatus,
  NativeToolName,
} from '../shared/native-tools'

const TOOL_NAMES = new Set<NativeToolName>([
  'extract_file', 'capture_screen', 'list_reminders', 'create_reminder', 'cancel_reminder',
  'write_clipboard', 'open_url', 'reveal_path',
])
const STATUSES = new Set<NativeToolAuditStatus>([
  'requested', 'awaiting_confirmation', 'denied', 'succeeded', 'failed',
])

function sanitizeInput(value: unknown): NativeToolAuditInput | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (
    typeof input.requestId !== 'string'
    || !input.requestId.trim()
    || !TOOL_NAMES.has(input.tool as NativeToolName)
    || !STATUSES.has(input.status as NativeToolAuditStatus)
    || !['default', 'stock_expert'].includes(String(input.roleId))
  ) return null
  const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, 300) : ''
  if (!summary) return null
  return {
    requestId: input.requestId.trim().slice(0, 120),
    roleId: input.roleId as NativeToolAuditInput['roleId'],
    tool: input.tool as NativeToolName,
    summary,
    status: input.status as NativeToolAuditStatus,
    ...(typeof input.error === 'string' && input.error.trim()
      ? { error: input.error.trim().slice(0, 300) }
      : {}),
  }
}

function sanitizeEntry(value: unknown): NativeToolAuditEntry | null {
  const input = sanitizeInput(value)
  if (!input || !value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || typeof entry.timestamp !== 'number') return null
  return { ...input, id: entry.id, timestamp: entry.timestamp }
}

export class NativeToolAuditStore {
  private entries: NativeToolAuditEntry[] = []

  constructor(private readonly storagePath: string) {
    this.load()
  }

  append(value: unknown): NativeToolAuditEntry | null {
    const input = sanitizeInput(value)
    if (!input) return null
    const entry: NativeToolAuditEntry = {
      ...input,
      id: randomUUID(),
      timestamp: Date.now(),
    }
    this.entries.unshift(entry)
    this.entries = this.entries.slice(0, 200)
    this.persist()
    return entry
  }

  list(): NativeToolAuditEntry[] {
    return this.entries.slice(0, 100).map((entry) => ({ ...entry }))
  }

  clear(): void {
    this.entries = []
    this.persist()
  }

  private load(): void {
    try {
      const value = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'))
      this.entries = Array.isArray(value)
        ? value.map(sanitizeEntry).filter((entry): entry is NativeToolAuditEntry => Boolean(entry)).slice(0, 200)
        : []
    } catch {
      this.entries = []
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
    fs.writeFileSync(this.storagePath, JSON.stringify(this.entries, null, 2), { mode: 0o600 })
  }
}
