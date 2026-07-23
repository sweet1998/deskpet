import { describe, expect, it } from 'vitest'
import {
  parseNativeToolIntent,
  parseNativeToolIntents,
  parseReminder,
  shouldPlanNativeTools,
} from './native-intent'

function localDate(year: number, month: number, day: number, hour: number): Date {
  return new Date(year, month - 1, day, hour, 0, 0, 0)
}

const NOW = localDate(2026, 7, 21, 10)

describe('native intent router', () => {
  it('parses relative and calendar reminders', () => {
    expect(parseReminder('20分钟后提醒我喝水', NOW)).toMatchObject({
      body: '喝水',
      dueAt: NOW.getTime() + 20 * 60_000,
    })
    expect(parseReminder('明天下午3点提醒我交周报', NOW)).toMatchObject({
      body: '交周报',
      dueAt: localDate(2026, 7, 22, 15).getTime(),
    })
  })

  it('parses colloquial, weekday and time-only reminders without scheduling the past', () => {
    expect(parseReminder('半小时后提醒我站起来', NOW)).toMatchObject({
      body: '站起来',
      dueAt: NOW.getTime() + 30 * 60_000,
    })
    expect(parseReminder('下周一上午9点提醒我开周会', NOW)).toMatchObject({
      body: '开周会',
      dueAt: localDate(2026, 7, 27, 9).getTime(),
    })
    expect(parseReminder('晚上8点提醒我关窗', NOW)).toMatchObject({
      body: '关窗',
      dueAt: localDate(2026, 7, 21, 20).getTime(),
    })
    expect(parseReminder('今天上午9点提醒我开会', NOW)).toBeNull()
  })

  it('routes reminder lists without asking the model', () => {
    expect(parseNativeToolIntent('查看我的提醒', NOW)).toMatchObject({
      kind: 'immediate',
      name: 'list_reminders',
    })
  })

  it('requires confirmation for clipboard writes and external URLs', () => {
    expect(parseNativeToolIntent('把 600519 复制到剪贴板', NOW)).toMatchObject({
      kind: 'confirmation',
      pending: { name: 'write_clipboard', text: '600519' },
    })
    expect(parseNativeToolIntent('打开 https://example.com/report', NOW)).toMatchObject({
      kind: 'confirmation',
      pending: { name: 'open_url', url: 'https://example.com/report' },
    })
  })

  it('does not read clipboard contents through a hidden command', () => {
    expect(parseNativeToolIntent('读取剪贴板内容', NOW)).toBeNull()
  })

  it('splits an explicit multi-step system request without losing confirmation boundaries', () => {
    const intents = parseNativeToolIntents(
      '明天下午3点提醒我交周报，然后打开 https://example.com/report，再把 600519 复制到剪贴板',
      NOW,
    )
    expect(intents).toHaveLength(3)
    expect(intents.map((item) => item.name)).toEqual(['create_reminder', 'open_url', 'write_clipboard'])
    expect(intents.every((item) => item.kind === 'confirmation')).toBe(true)
  })

  it('ignores unrelated conversation', () => {
    expect(parseNativeToolIntent('今天白酒行情怎么样', NOW)).toBeNull()
    expect(shouldPlanNativeTools('今天白酒行情怎么样')).toBe(false)
  })

  it('routes colloquial system requests to the structured planner', () => {
    expect(shouldPlanNativeTools('半小时后叫我起来活动')).toBe(true)
    expect(shouldPlanNativeTools('别让我忘了明天交周报')).toBe(true)
    expect(shouldPlanNativeTools('把这段内容留到剪贴板')).toBe(true)
  })
})
