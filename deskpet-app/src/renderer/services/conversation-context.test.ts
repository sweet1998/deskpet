import { describe, expect, it } from 'vitest'
import { selectConversationContext, startsNewConversationTopic } from './conversation-context'

describe('conversation context', () => {
  it('keeps previous turns for an implicit follow-up', () => {
    const history = [
      { role: 'user' as const, content: '分析贵州茅台' },
      { role: 'assistant' as const, content: '贵州茅台近期处于震荡。' },
    ]

    expect(selectConversationContext(history, '为什么最近跌这么厉害')).toEqual(history)
  })

  it('drops history when the current message explicitly starts a new topic', () => {
    expect(startsNewConversationTopic('换个话题，聊聊别的')).toBe(true)
    expect(selectConversationContext([
      { role: 'user', content: '分析 600519' },
    ], '忽略前面，什么是市盈率')).toEqual([])
  })

  it('does not cross the latest topic reset boundary', () => {
    expect(selectConversationContext([
      { role: 'user', content: '分析 600519' },
      { role: 'assistant', content: '茅台近期震荡。' },
      { role: 'user', content: '换个话题，看看白酒板块' },
      { role: 'assistant', content: '白酒板块近期走弱。' },
    ], '为什么最近跌这么厉害')).toEqual([
      { role: 'user', content: '换个话题，看看白酒板块' },
      { role: 'assistant', content: '白酒板块近期走弱。' },
    ])
  })

  it('keeps only the latest configured number of messages', () => {
    const history = Array.from({ length: 24 }, (_, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: String(index),
    }))
    expect(selectConversationContext(history, '继续分析')).toHaveLength(20)
    expect(selectConversationContext(history, '继续分析')[0].content).toBe('4')
  })
})
