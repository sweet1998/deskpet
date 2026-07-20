import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chat'

describe('chat store roles', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('isolates history between roles', () => {
    const chat = useChatStore()
    chat.addUserMessage('你好', 'default-1', 'default')
    chat.setActiveRole('stock_expert')
    chat.addUserMessage('分析 600519', 'stock-1', 'stock_expert')

    expect(chat.messages.map((message) => message.type === 'text' ? message.text : '')).toEqual(['分析 600519'])
    expect(chat.messagesByRole.default).toHaveLength(1)
    expect(chat.messagesByRole.stock_expert).toHaveLength(1)
  })

  it('routes a late response back to the request role', () => {
    const chat = useChatStore()
    chat.addUserMessage('旧问题', 'req-old', 'default')
    chat.setActiveRole('stock_expert')
    chat.appendChatText('旧角色回复', 'req-old')

    expect(chat.messagesByRole.default.at(-1)).toMatchObject({ role: 'assistant', text: '旧角色回复' })
    expect(chat.messagesByRole.stock_expert).toEqual([])
    expect(chat.bubbleVisible).toBe(false)
  })

  it('stores a collapsible analysis record before the formal answer', () => {
    const chat = useChatStore()
    chat.bindRequest('req-thought', 'stock_expert')
    chat.appendThought('req-thought', '贵州茅台：现价 1500 元')
    chat.appendThought('req-thought', '贵州茅台：现价 1500 元')
    chat.appendThought('req-thought', '近20日上涨 3.2%')
    chat.finishThought('req-thought')

    const thought = chat.messagesByRole.stock_expert[0]
    expect(thought).toMatchObject({ type: 'thought', complete: true, collapsed: true })
    expect(thought.type === 'thought' && thought.steps).toHaveLength(2)
    chat.toggleThought('req-thought')
    expect(thought.type === 'thought' && thought.collapsed).toBe(false)
  })

  it('stores one retryable status message and resolves the original request text', () => {
    const chat = useChatStore()
    chat.addUserMessage('再试一次', 'req-error', 'default')
    chat.showStatusMessage('req-error', '网络异常', 'network')
    chat.showStatusMessage('req-error', '响应超时', 'timeout')

    expect(chat.getRequestText('req-error')).toBe('再试一次')
    expect(chat.messagesByRole.default).toHaveLength(2)
    expect(chat.messagesByRole.default[1]).toMatchObject({
      id: 'status-req-error',
      type: 'status',
      text: '响应超时',
      code: 'timeout',
      retryable: true,
    })
  })
})
