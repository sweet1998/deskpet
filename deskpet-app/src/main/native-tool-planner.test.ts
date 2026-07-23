import { describe, expect, it, vi } from 'vitest'
import { normalizeNativeToolPlan, planNativeTools } from './native-tool-planner'

const NOW = new Date('2026-07-22T10:00:00+08:00').getTime()
const reminders = [{
  id: 'reminder-existing',
  title: '麦麦提醒',
  body: '交周报',
  dueAt: NOW + 60_000,
  createdAt: NOW - 60_000,
  status: 'scheduled' as const,
}]

describe('native tool planner', () => {
  it('normalizes only whitelisted operations with validated arguments', () => {
    const intents = normalizeNativeToolPlan({ operations: [
      { name: 'create_reminder', body: '喝水', dueAt: NOW + 30 * 60_000 },
      { name: 'open_url', url: 'https://example.com/report' },
      { name: 'write_clipboard', text: '600519' },
      { name: 'reveal_path', path: '/Users/test/report.pdf' },
      { name: 'cancel_reminder', reminderId: 'reminder-existing' },
    ] }, { now: NOW, reminders })

    expect(intents.map((item) => item.name)).toEqual([
      'create_reminder', 'open_url', 'write_clipboard', 'reveal_path', 'cancel_reminder',
    ])
  })

  it('rejects unsafe protocols, relative paths, unknown reminder ids and excess plans', () => {
    expect(normalizeNativeToolPlan({ operations: [
      { name: 'open_url', url: 'file:///tmp/private' },
      { name: 'reveal_path', path: '../private' },
      { name: 'cancel_reminder', reminderId: 'made-up' },
      { name: 'read_clipboard' },
    ] }, { now: NOW, reminders })).toEqual([])
    expect(normalizeNativeToolPlan({ operations: Array.from({ length: 6 }, () => ({
      name: 'list_reminders',
    })) }, { now: NOW, reminders })).toEqual([])
  })

  it('requests strict JSON and returns a confirmable colloquial reminder plan', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({
        operations: [{
          name: 'create_reminder',
          title: '麦麦提醒',
          body: '起来活动',
          dueAt: new Date(NOW + 30 * 60_000).toISOString(),
        }],
      }) } }] }),
    })

    const result = await planNativeTools(
      { apiKey: 'secret', model: 'ep-test' },
      { text: '半小时后叫我起来活动', now: NOW, reminders: [] },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    )

    expect(result.intents[0]).toMatchObject({
      kind: 'confirmation',
      pending: { name: 'create_reminder', reminder: { body: '起来活动' } },
    })
    const request = fetchImpl.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({
      temperature: 0,
      response_format: { type: 'json_object' },
    })
  })
})
