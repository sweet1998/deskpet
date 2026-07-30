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
    expect(STOCK_ROUTE_SYSTEM_PROMPT).toBe([
      contract.stockRouter.systemPrompt,
      contract.stockClarificationRouting,
    ].join('\n'))
    expect(STOCK_ROUTE_SYSTEM_PROMPT).toContain('不得用低 confidence 的 out_of_scope 表示不确定')
    expect(STOCK_ROUTE_SYSTEM_PROMPT).toContain('存在多个可能目标')
    expect(COMPLETION_MARKER).toBe(contract.completion.marker)
    expect(COMPLETION_INSTRUCTION).toContain(COMPLETION_MARKER)
    expect(COMPLETION_INSTRUCTION).toContain('回答必须完整表述')
    expect(COMPLETION_INSTRUCTION).toContain('所有观点说完后再结束输出')
    expect(COMPLETION_INSTRUCTION).toContain('如果内容较长，请完整分段输出')
    expect(COMPLETION_INSTRUCTION).toContain('严禁未说完就停止')
  })

  it('builds role identity, memory, and research context consistently', () => {
    const prompt = roleSystemPrompt({
      roleId: 'stock_expert',
      dateContext: '当前北京时间日期：2026年7月27日。',
      userName: '小麦',
      memories: ['偏好短回答'],
      research: { intent: 'sector', skills: ['market-snapshot', 'fact-verifier'], context: { sector: '白酒' } },
    })

    expect(prompt).toContain('你是麦麦的 A 股研究助手')
    expect(prompt).toContain('用户希望被称为：小麦。')
    expect(prompt).toContain('用户明确要求记住：偏好短回答')
    expect(prompt).toContain('本次问题意图：sector。')
    expect(prompt).toContain('market-snapshot, fact-verifier')
    expect(prompt).toContain('禁止声称没有执行工具')
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
