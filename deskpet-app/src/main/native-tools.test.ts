import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'

const electron = vi.hoisted(() => ({
  notifications: [] as Array<{ title: string; body: string }>,
  clipboardText: '',
  openExternal: vi.fn().mockResolvedValue(undefined),
  showItemInFolder: vi.fn(),
}))

vi.mock('electron', () => ({
  Notification: class {
    static isSupported() { return true }
    constructor(private readonly options: { title: string; body: string }) {}
    show() { electron.notifications.push(this.options) }
  },
  clipboard: {
    readText: () => electron.clipboardText,
    writeText: (value: string) => { electron.clipboardText = value },
  },
  shell: {
    openExternal: electron.openExternal,
    showItemInFolder: electron.showItemInFolder,
  },
}))

import {
  NativeReminderManager,
  extractNativeFile,
  openNativeUrl,
  writeNativeClipboard,
} from './native-tools'
import type { PersistentReminderScheduler } from './persistent-reminders'

describe('native tools', () => {
  let directory = ''

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-native-tools-'))
    electron.notifications.length = 0
    electron.clipboardText = ''
    electron.openExternal.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('extracts local text attachments and rejects unsupported files', async () => {
    const text = Buffer.from('第一行\n第二行').toString('base64')
    await expect(extractNativeFile({ name: 'notes.md', mimeType: 'text/markdown', size: 20, base64: text }))
      .resolves.toMatchObject({ ok: true, text: '第一行\n第二行' })
    await expect(extractNativeFile({ name: 'script.sh', mimeType: 'text/plain', size: 20, base64: text }))
      .resolves.toMatchObject({ ok: false })
  })

  it('extracts DOCX and XLSX locally without sending binary files to a service', async () => {
    const docx = new JSZip()
    docx.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`)
    docx.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`)
    docx.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>会议纪要：周五发布</w:t></w:r></w:p></w:body>
      </w:document>`)
    const docxBuffer = await docx.generateAsync({ type: 'nodebuffer' })

    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('持仓观察')
    worksheet.addRow(['代码', '名称', '价格'])
    worksheet.addRow(['600519', '贵州茅台', 1500])
    const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer())

    await expect(extractNativeFile({
      name: 'meeting.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: docxBuffer.length, base64: docxBuffer.toString('base64'),
    })).resolves.toMatchObject({ ok: true, text: expect.stringContaining('周五发布') })
    const spreadsheet = await extractNativeFile({
      name: 'watchlist.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: xlsxBuffer.length, base64: xlsxBuffer.toString('base64'),
    })
    expect(spreadsheet, JSON.stringify(spreadsheet)).toMatchObject({ ok: true })
    expect(spreadsheet.text).toContain('[工作表：持仓观察]')
    expect(spreadsheet.text).toContain('600519\t贵州茅台\t1500')
  })

  it('reports when a long local attachment was truncated', async () => {
    const value = Buffer.from('字'.repeat(40_100))
    await expect(extractNativeFile({
      name: 'long.txt', mimeType: 'text/plain', size: value.length, base64: value.toString('base64'),
    })).resolves.toMatchObject({ ok: true, characters: 40_100, truncated: true })
  })

  it('uses the injected local OCR helper for image attachments', async () => {
    const image = Buffer.from('fake-image')
    const ocr = vi.fn().mockResolvedValue({ ok: true, text: '图片中的文字', truncated: false })
    await expect(extractNativeFile({
      name: 'note.png', mimeType: 'image/png', size: image.length, base64: image.toString('base64'),
    }, { ocr })).resolves.toMatchObject({ ok: true, text: '图片中的文字' })
    expect(ocr).toHaveBeenCalledWith(expect.any(Buffer), 'png')
  })

  it('uses PDFKit and Vision through the native helper for PDF attachments', async () => {
    const document = Buffer.from('fake-pdf')
    const ocr = vi.fn().mockResolvedValue({ ok: true, text: '[第 1 页]\nPDF 正文', pages: 1 })
    await expect(extractNativeFile({
      name: 'report.pdf', mimeType: 'application/pdf', size: document.length, base64: document.toString('base64'),
    }, { ocr })).resolves.toMatchObject({ ok: true, text: '[第 1 页]\nPDF 正文' })
    expect(ocr).toHaveBeenCalledWith(expect.any(Buffer), 'pdf')
  })

  it('persists, triggers and cancels reminders', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T10:00:00+08:00'))
    const triggered = vi.fn()
    const manager = new NativeReminderManager(path.join(directory, 'reminders.json'), triggered)
    manager.start()
    const first = manager.create({ title: '麦麦提醒', body: '喝水', dueAt: Date.now() + 5_000 })
    const second = manager.create({ title: '麦麦提醒', body: '开会', dueAt: Date.now() + 10_000 })

    expect(manager.cancel(second.id)).toBe(true)
    vi.advanceTimersByTime(5_100)

    expect(triggered).toHaveBeenCalledWith(expect.objectContaining({ id: first.id, status: 'delivered' }))
    expect(electron.notifications).toEqual([{ title: '麦麦提醒', body: '喝水' }])
    expect(manager.list().find((item) => item.id === second.id)?.status).toBe('cancelled')
    manager.clear()
    expect(manager.list()).toEqual([])
    manager.stop()
  })

  it('delivers overdue reminders when the app starts again', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T10:00:00+08:00'))
    const storagePath = path.join(directory, 'reminders.json')
    fs.writeFileSync(storagePath, JSON.stringify([{
      id: 'overdue-reminder',
      title: '麦麦提醒',
      body: '补发通知',
      dueAt: Date.now() - 5_000,
      createdAt: Date.now() - 60_000,
      status: 'scheduled',
    }]))
    const triggered = vi.fn()
    const manager = new NativeReminderManager(storagePath, triggered)

    manager.start()
    vi.runOnlyPendingTimers()

    expect(electron.notifications).toEqual([{ title: '麦麦提醒', body: '补发通知' }])
    expect(triggered).toHaveBeenCalledWith(expect.objectContaining({
      id: 'overdue-reminder',
      status: 'delivered',
    }))
    manager.stop()
  })

  it('coordinates in-app delivery with the persistent scheduler', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T10:00:00+08:00'))
    const scheduler: PersistentReminderScheduler = {
      schedule: vi.fn(() => true),
      tryClaim: vi.fn(() => true),
      complete: vi.fn(),
      cancel: vi.fn(),
      clear: vi.fn(),
      consumeDelivered: vi.fn(() => new Set<string>()),
    }
    const manager = new NativeReminderManager(
      path.join(directory, 'reminders.json'),
      vi.fn(),
      scheduler,
    )
    manager.start()
    const reminder = manager.create({ title: '麦麦提醒', body: '交周报', dueAt: Date.now() + 5_000 })

    vi.advanceTimersByTime(5_100)

    expect(scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: reminder.id }))
    expect(scheduler.tryClaim).toHaveBeenCalledWith(reminder.id)
    expect(scheduler.complete).toHaveBeenCalledWith(reminder.id)
    expect(electron.notifications).toHaveLength(1)
    manager.stop()
  })

  it('reconciles a reminder delivered while the app was closed without duplicating it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T10:00:00+08:00'))
    const storagePath = path.join(directory, 'reminders.json')
    fs.writeFileSync(storagePath, JSON.stringify([{
      id: 'background-reminder',
      title: '麦麦提醒',
      body: '后台通知',
      dueAt: Date.now() - 5_000,
      createdAt: Date.now() - 60_000,
      status: 'scheduled',
    }]))
    const scheduler: PersistentReminderScheduler = {
      schedule: vi.fn(() => true),
      tryClaim: vi.fn(() => false),
      complete: vi.fn(),
      cancel: vi.fn(),
      clear: vi.fn(),
      consumeDelivered: vi.fn(() => new Set(['background-reminder'])),
    }
    const triggered = vi.fn()
    const manager = new NativeReminderManager(storagePath, triggered, scheduler)

    manager.start()

    expect(manager.list().find((item) => item.id === 'background-reminder')?.status).toBe('delivered')
    expect(triggered).toHaveBeenCalledOnce()
    expect(electron.notifications).toEqual([])
    manager.stop()
  })

  it('validates native clipboard and external URL operations', async () => {
    expect(writeNativeClipboard('600519')).toBe(true)
    await expect(openNativeUrl('file:///tmp/secret')).resolves.toBe(false)
    await expect(openNativeUrl('https://example.com')).resolves.toBe(true)
    expect(electron.openExternal).toHaveBeenCalledOnce()
  })
})
