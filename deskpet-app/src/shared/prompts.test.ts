import { describe, expect, it } from 'vitest'
import contract from './prompt-contract.json'
import {
  COMPLETION_INSTRUCTION,
  COMPLETION_MARKER,
  PROMPT_CONTRACT_VERSION,
  STOCK_ROUTE_SYSTEM_PROMPT,
  researchPrompt,
  roleSystemPrompt,
  tradingCalendarPrompt,
} from './prompts'

describe('shared prompt contract', () => {
  it('provides routing and completion instructions from one contract', () => {
    expect(PROMPT_CONTRACT_VERSION).toBe(contract.version)
    expect(STOCK_ROUTE_SYSTEM_PROMPT).toBe(contract.stockRouter.systemPrompt)
    expect(COMPLETION_MARKER).toBe(contract.completion.marker)
    expect(COMPLETION_INSTRUCTION).toContain(COMPLETION_MARKER)
  })

  it('builds role identity, memory, and research context consistently', () => {
    const prompt = roleSystemPrompt({
      roleId: 'stock_expert',
      dateContext: '当前北京时间日期：2026年7月27日。',
      userName: '小麦',
      memories: ['偏好短回答'],
      research: { intent: 'sector', context: { sector: '白酒' } },
    })

    expect(prompt).toContain('你是麦麦的 A 股研究助手')
    expect(prompt).toContain('用户希望被称为：小麦。')
    expect(prompt).toContain('用户明确要求记住：偏好短回答')
    expect(prompt).toContain('本次问题意图：sector。')
    expect(prompt).toContain('{"sector":"白酒"}')
  })

  it('uses intent-specific instructions only when no market context exists', () => {
    expect(researchPrompt({ intent: 'answer_followup' })).toContain('上一条回答')
    expect(researchPrompt({ intent: 'education' })).toContain('核心概念')
  })

  it('builds trading-calendar facts with the shared relative-time rule', () => {
    const prompt = tradingCalendarPrompt({
      source: 'akshare',
      today: { date: '2026-07-27', weekday: '星期一', isTradingDay: true },
      tomorrow: { date: '2026-07-28', weekday: '星期二', isTradingDay: true },
      nextTradingDay: { date: '2026-07-28', weekday: '星期二' },
    })

    expect(prompt).toContain('今天是A股交易日')
    expect(prompt).toContain('下一个交易日是 2026-07-28 星期二')
    expect(prompt).toContain(contract.date.relativeTimeRule)
  })
})
