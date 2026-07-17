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
})
