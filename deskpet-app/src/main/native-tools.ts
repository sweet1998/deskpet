import { Notification, clipboard, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import ExcelJS from 'exceljs'
import mammoth from 'mammoth'
import type {
  NativeFileExtractionInput,
  NativeFileExtractionResult,
  NativeReminder,
  NativeReminderInput,
} from '../shared/native-tools'
import type { PersistentReminderScheduler } from './persistent-reminders'

const MAX_FILE_BYTES = 12 * 1024 * 1024
const MAX_EXTRACTED_CHARACTERS = 40_000
const MAX_TIMER_DELAY = 2_000_000_000
const MAX_REMINDER_AGE = 366 * 24 * 60 * 60 * 1000
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'log'])
const DOCUMENT_EXTENSIONS = new Set(['docx', 'xlsx'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'heic', 'webp', 'tif', 'tiff'])

interface NativeFileExtractionOptions {
  ocr?: (buffer: Buffer, extension: string) => Promise<{
    ok: boolean
    text?: string
    truncated?: boolean
    error?: string
  }>
}

function safeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, maxLength) : ''
}

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase()
}

export async function extractNativeFile(
  input: NativeFileExtractionInput,
  options: NativeFileExtractionOptions = {},
): Promise<NativeFileExtractionResult> {
  const name = safeText(input?.name, 180) || '附件'
  if (!input || typeof input.base64 !== 'string' || !input.base64) {
    return { ok: false, name, error: '文件内容为空' }
  }
  if (!Number.isFinite(input.size) || input.size <= 0 || input.size > MAX_FILE_BYTES) {
    return { ok: false, name, error: '文件不能超过 12MB' }
  }
  const extension = extensionOf(name)
  if (
    extension !== 'pdf'
    && !TEXT_EXTENSIONS.has(extension)
    && !DOCUMENT_EXTENSIONS.has(extension)
    && !IMAGE_EXTENSIONS.has(extension)
  ) {
    return { ok: false, name, error: '目前支持 PDF、DOCX、XLSX、图片、TXT、Markdown、JSON 和 CSV 文件' }
  }
  try {
    const buffer = Buffer.from(input.base64, 'base64')
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error('文件内容无效')
    let ocrTruncated = false
    let extracted = ''
    if (extension === 'docx') {
      extracted = (await mammoth.extractRawText({ buffer })).value
    } else if (extension === 'xlsx') {
      extracted = await extractSpreadsheet(buffer)
    } else if (!IMAGE_EXTENSIONS.has(extension)) {
      extracted = buffer.toString('utf-8')
    }
    if (extension === 'pdf' || IMAGE_EXTENSIONS.has(extension)) {
      if (!options.ocr) return { ok: false, name, error: '当前环境没有可用的 macOS 文字识别组件' }
      const recognized = await options.ocr(buffer, extension)
      if (!recognized.ok || !recognized.text) {
        return { ok: false, name, error: recognized.error || '没有识别到可读文字' }
      }
      extracted = recognized.text
      ocrTruncated = recognized.truncated === true
    }
    const normalized = extracted.replace(/\0/g, '').trim()
    if (!normalized) return { ok: false, name, error: '没有从文件中提取到可读文字' }
    const truncated = ocrTruncated || normalized.length > MAX_EXTRACTED_CHARACTERS
    const text = normalized.slice(0, MAX_EXTRACTED_CHARACTERS)
    return { ok: true, name, text, characters: normalized.length, truncated }
  } catch (error) {
    return {
      ok: false,
      name,
      error: error instanceof Error ? `文件解析失败：${error.message}` : '文件解析失败',
    }
  }
}

function spreadsheetCellText(value: unknown): string {
  if (value == null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'object') return ''
  const cell = value as Record<string, unknown>
  if (cell.result != null) return spreadsheetCellText(cell.result)
  if (Array.isArray(cell.richText)) {
    return cell.richText.map((item) => (
      item && typeof item === 'object' ? spreadsheetCellText((item as Record<string, unknown>).text) : ''
    )).join('')
  }
  if (typeof cell.text === 'string') return cell.text
  if (typeof cell.hyperlink === 'string') return cell.hyperlink
  return ''
}

async function extractSpreadsheet(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  const sections: string[] = []
  for (const sheet of workbook.worksheets.slice(0, 20)) {
    const rows: string[] = []
    const rowLimit = Math.min(sheet.actualRowCount, 5_000)
    for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
      const row = sheet.getRow(rowNumber)
      const cells: string[] = []
      const columnLimit = Math.min(row.cellCount, 100)
      for (let column = 1; column <= columnLimit; column += 1) {
        cells.push(spreadsheetCellText(row.getCell(column).value).replace(/[\t\r\n]+/g, ' '))
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t').replace(/\t+$/g, ''))
      if (rows.join('\n').length >= MAX_EXTRACTED_CHARACTERS) break
    }
    if (rows.length) sections.push(`[工作表：${sheet.name}]\n${rows.join('\n')}`)
    if (sections.join('\n\n').length >= MAX_EXTRACTED_CHARACTERS) break
  }
  return sections.join('\n\n')
}

function sanitizeStoredReminder(value: unknown): NativeReminder | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const status = ['scheduled', 'delivered', 'cancelled'].includes(String(item.status))
    ? item.status as NativeReminder['status']
    : null
  if (
    typeof item.id !== 'string'
    || typeof item.dueAt !== 'number'
    || typeof item.createdAt !== 'number'
    || !status
  ) return null
  const title = safeText(item.title, 80)
  const body = safeText(item.body, 300)
  if (!title || !body) return null
  return { id: item.id, title, body, dueAt: item.dueAt, createdAt: item.createdAt, status }
}

export class NativeReminderManager {
  private reminders: NativeReminder[] = []
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private persistentlyScheduled = new Set<string>()

  constructor(
    private readonly storagePath: string,
    private readonly onTriggered: (reminder: NativeReminder) => void,
    private readonly persistentScheduler?: PersistentReminderScheduler,
  ) {}

  start(): void {
    this.load()
    this.reconcilePersistentDeliveries()
    for (const reminder of this.reminders) {
      if (reminder.status !== 'scheduled') continue
      if (this.persistentScheduler?.schedule(reminder)) {
        this.persistentlyScheduled.add(reminder.id)
      } else if (this.persistentScheduler) {
        console.warn(`[deskpet] Could not register persistent reminder ${reminder.id}; keeping in-app timer`)
      }
      this.schedule(reminder)
    }
    this.persist()
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  list(): NativeReminder[] {
    this.reconcilePersistentDeliveries()
    return [...this.reminders]
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 100)
  }

  create(input: NativeReminderInput): NativeReminder {
    const title = safeText(input?.title, 80)
    const body = safeText(input?.body, 300)
    const dueAt = Number(input?.dueAt)
    const now = Date.now()
    if (!title || !body) throw new Error('提醒内容不能为空')
    if (!Number.isFinite(dueAt) || dueAt < now + 3_000) throw new Error('提醒时间必须晚于当前时间')
    if (dueAt > now + MAX_REMINDER_AGE) throw new Error('提醒时间不能超过一年')
    const reminder: NativeReminder = {
      id: randomUUID(),
      title,
      body,
      dueAt,
      createdAt: now,
      status: 'scheduled',
    }
    if (this.persistentScheduler && !this.persistentScheduler.schedule(reminder)) {
      throw new Error('无法注册 macOS 后台提醒，请检查系统权限后重试')
    }
    if (this.persistentScheduler) this.persistentlyScheduled.add(reminder.id)
    this.reminders.push(reminder)
    this.schedule(reminder)
    this.persist()
    return reminder
  }

  cancel(id: string): boolean {
    const reminder = this.reminders.find((item) => item.id === id && item.status === 'scheduled')
    if (!reminder) return false
    reminder.status = 'cancelled'
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.persistentlyScheduled.delete(id)
    this.persistentScheduler?.cancel(id)
    this.persist()
    return true
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.persistentScheduler?.clear(this.reminders.map((reminder) => reminder.id))
    this.persistentlyScheduled.clear()
    this.reminders = []
    this.persist()
  }

  private load(): void {
    try {
      const value = JSON.parse(fs.readFileSync(this.storagePath, 'utf-8'))
      this.reminders = Array.isArray(value)
        ? value.map(sanitizeStoredReminder).filter((item): item is NativeReminder => Boolean(item))
        : []
    } catch {
      this.reminders = []
    }
  }

  private persist(): void {
    const retentionStart = Date.now() - 30 * 24 * 60 * 60 * 1000
    this.reminders = this.reminders
      .filter((reminder) => reminder.status === 'scheduled' || reminder.dueAt >= retentionStart)
      .slice(-500)
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true })
    fs.writeFileSync(this.storagePath, JSON.stringify(this.reminders, null, 2), { mode: 0o600 })
  }

  private schedule(reminder: NativeReminder): void {
    const existing = this.timers.get(reminder.id)
    if (existing) clearTimeout(existing)
    const delay = reminder.dueAt - Date.now()
    const timer = setTimeout(() => {
      this.timers.delete(reminder.id)
      if (reminder.status !== 'scheduled') return
      if (reminder.dueAt - Date.now() > 1_000) {
        this.schedule(reminder)
        return
      }
      if (this.persistentlyScheduled.has(reminder.id)) {
        if (!this.persistentScheduler?.tryClaim(reminder.id)) {
          if (this.reconcilePersistentDeliveries().has(reminder.id)) return
          const retry = setTimeout(() => this.schedule(reminder), 500)
          this.timers.set(reminder.id, retry)
          return
        }
      }
      this.deliverInApp(reminder)
    }, Math.max(0, Math.min(delay, MAX_TIMER_DELAY)))
    this.timers.set(reminder.id, timer)
  }

  private deliverInApp(reminder: NativeReminder): void {
    reminder.status = 'delivered'
    this.persistentlyScheduled.delete(reminder.id)
    this.persistentScheduler?.complete(reminder.id)
    this.persist()
    if (Notification.isSupported()) {
      new Notification({ title: reminder.title, body: reminder.body }).show()
    }
    this.onTriggered({ ...reminder })
  }

  private reconcilePersistentDeliveries(): Set<string> {
    const delivered = this.persistentScheduler?.consumeDelivered() ?? new Set<string>()
    if (!delivered.size) return delivered
    let changed = false
    for (const reminder of this.reminders) {
      if (!delivered.has(reminder.id) || reminder.status !== 'scheduled') continue
      reminder.status = 'delivered'
      const timer = this.timers.get(reminder.id)
      if (timer) clearTimeout(timer)
      this.timers.delete(reminder.id)
      this.persistentlyScheduled.delete(reminder.id)
      this.persistentScheduler?.complete(reminder.id)
      this.onTriggered({ ...reminder })
      changed = true
    }
    if (changed) this.persist()
    return delivered
  }
}

export function writeNativeClipboard(text: unknown): boolean {
  const normalized = safeText(text, 100_000)
  if (!normalized) return false
  clipboard.writeText(normalized)
  return true
}

export async function openNativeUrl(value: unknown): Promise<boolean> {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return false
    await shell.openExternal(url.toString())
    return true
  } catch {
    return false
  }
}

export function revealNativePath(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false
  const target = path.resolve(value.trim())
  if (!fs.existsSync(target)) return false
  shell.showItemInFolder(target)
  return true
}
