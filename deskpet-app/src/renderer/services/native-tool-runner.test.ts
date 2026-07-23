// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  auditNativeTool,
  createNativeToolPlan,
  executeNativeTool,
  nativeConfirmationExpired,
} from './native-tool-runner'

const api = {
  appendNativeToolAudit: vi.fn(),
  createNativeReminder: vi.fn(),
  cancelNativeReminder: vi.fn(),
  writeNativeClipboard: vi.fn(),
  openNativeUrl: vi.fn(),
  revealNativePath: vi.fn(),
}

describe('native tool runner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: api })
  })

  it('creates a confirmable plan with a risk level', () => {
    const plan = createNativeToolPlan(
      'req-1',
      'default',
      '打开报告',
      [{
        tool: { name: 'open_url', url: 'https://example.com' },
        summary: '打开 https://example.com',
      }],
    )
    expect(plan.steps[0]).toMatchObject({
      tool: 'open_url', risk: 'medium', requiresConfirmation: true,
    })
  })

  it('builds an ordered plan for multiple separately confirmable operations', () => {
    const plan = createNativeToolPlan('req-many', 'default', '准备会议', [
      {
        tool: { name: 'create_reminder', reminder: { title: '提醒', body: '开会', dueAt: 123 } },
        summary: '设置开会提醒',
      },
      {
        tool: { name: 'open_url', url: 'https://example.com/meeting' },
        summary: '打开会议页面',
      },
    ])
    expect(plan.steps).toEqual([
      expect.objectContaining({ id: 'req-many-step-1', tool: 'create_reminder', risk: 'low' }),
      expect.objectContaining({ id: 'req-many-step-2', tool: 'open_url', risk: 'medium' }),
    ])
  })

  it('executes through validated preload methods and writes audit evidence', async () => {
    api.openNativeUrl.mockResolvedValue(true)
    api.appendNativeToolAudit.mockResolvedValue({ id: 'audit-1' })

    await expect(executeNativeTool({ name: 'open_url', url: 'https://example.com' }))
      .resolves.toContain('默认浏览器')
    await auditNativeTool({
      requestId: 'req-1', roleId: 'default', tool: 'open_url',
      summary: '打开网页', status: 'succeeded',
    })

    expect(api.openNativeUrl).toHaveBeenCalledWith('https://example.com')
    expect(api.appendNativeToolAudit).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }))
  })

  it('rejects missing and elapsed confirmation deadlines', () => {
    expect(nativeConfirmationExpired(Number.NaN, 1_000)).toBe(true)
    expect(nativeConfirmationExpired(999, 1_000)).toBe(true)
    expect(nativeConfirmationExpired(1_001, 1_000)).toBe(false)
  })
})
