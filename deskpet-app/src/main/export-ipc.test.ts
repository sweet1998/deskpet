// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeTextExport } from './export-ipc'

describe('export IPC input validation', () => {
  it('normalizes unsafe filenames without changing the content', () => {
    expect(normalizeTextExport({
      title: '  财报/复盘:第一版?  ',
      content: '正文内容',
    }, '默认标题', 100)).toEqual({
      title: '财报-复盘-第一版-',
      content: '正文内容',
    })
  })

  it('uses a fallback title and rejects empty or oversized content', () => {
    expect(normalizeTextExport({ content: '可导出' }, '麦麦对话', 20)).toEqual({
      title: '麦麦对话',
      content: '可导出',
    })
    expect(normalizeTextExport({ content: '   ' }, '麦麦对话', 20)).toBeNull()
    expect(normalizeTextExport({ content: '内容超过限制' }, '麦麦对话', 2)).toBeNull()
  })
})
