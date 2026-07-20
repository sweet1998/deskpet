import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chat'

describe('chat store roles', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

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

  it('restores completed role history and drafts after reloading the store', () => {
    const chat = useChatStore()
    chat.addUserMessage('分析科技板块', 'req-persist', 'stock_expert')
    chat.appendChatText('科技板块近期偏弱', 'req-persist')
    chat.finishChatStream('req-persist')
    chat.setDraft('stock_expert', '继续分析半导体')

    setActivePinia(createPinia())
    const restored = useChatStore()

    expect(restored.messagesByRole.stock_expert.map((message) => message.type)).toEqual(['text', 'text'])
    expect(restored.messagesByRole.stock_expert.at(-1)).toMatchObject({
      role: 'assistant',
      text: '科技板块近期偏弱',
      streaming: false,
    })
    expect(restored.draftsByRole.stock_expert).toBe('继续分析半导体')
  })

  it('creates, switches and deletes independent conversations within one role', () => {
    const chat = useChatStore()
    chat.addUserMessage('第一段会话', 'req-first', 'default')
    const firstId = chat.activeConversation.id
    const second = chat.createConversation('default')
    chat.addUserMessage('第二段会话', 'req-second', 'default')

    expect(chat.conversations).toHaveLength(2)
    expect(chat.messages.map((message) => message.type === 'text' ? message.text : '')).toEqual(['第二段会话'])

    chat.setActiveConversation(firstId, 'default')
    expect(chat.messages.map((message) => message.type === 'text' ? message.text : '')).toEqual(['第一段会话'])

    chat.deleteConversation(second.id, 'default')
    expect(chat.conversations).toHaveLength(1)
    expect(chat.activeConversation.id).toBe(firstId)
  })

  it('keeps a late streamed answer in the conversation that started the request', () => {
    const chat = useChatStore()
    chat.addUserMessage('旧会话问题', 'req-bound', 'default')
    const oldConversation = chat.activeConversation
    chat.createConversation('default')

    chat.appendChatText('旧会话回答', 'req-bound')
    chat.finishChatStream('req-bound')

    expect(chat.activeConversation.messages).toEqual([])
    expect(oldConversation.messages.at(-1)).toMatchObject({ role: 'assistant', text: '旧会话回答' })
  })

  it('persists attachment metadata and structured market cards', () => {
    const chat = useChatStore()
    chat.addUserMessage('分析附件', 'req-card', 'stock_expert', [{
      id: 'file-1', name: 'report.pdf', mimeType: 'application/pdf', size: 1024,
    }])
    chat.showMarketCard('req-card', {
      title: '个股行情',
      items: [{ code: '600519', name: '贵州茅台', price: 1488, changePercent: 1.2 }],
      source: 'akshare-eastmoney',
    })

    setActivePinia(createPinia())
    const restored = useChatStore()
    const messages = restored.conversationsByRole.stock_expert[0].messages

    expect(messages[0]).toMatchObject({ type: 'text', attachments: [{ name: 'report.pdf', size: 1024 }] })
    expect(messages[1]).toMatchObject({
      type: 'market',
      card: { items: [{ code: '600519', price: 1488, changePercent: 1.2 }] },
    })
  })

  it('exports the active conversation as Markdown', () => {
    const chat = useChatStore()
    chat.addUserMessage('导出这段会话', 'req-export', 'default')
    chat.appendChatText('这是回答', 'req-export')
    chat.finishChatStream('req-export')

    const exported = chat.exportConversationMarkdown(chat.activeConversation.id)

    expect(exported?.title).toBe('导出这段会话')
    expect(exported?.content).toContain('## 我\n\n导出这段会话')
    expect(exported?.content).toContain('## 麦麦\n\n这是回答')
  })

  it('persists the answer reference used by a follow-up question', () => {
    const chat = useChatStore()
    chat.addUserMessage('它最大的风险是什么？', 'req-followup', 'stock_expert', [], {
      messageId: 'answer-previous',
      preview: '贵州茅台当前估值仍需结合利润增长判断。',
    })

    expect(chat.getRequestReplyTo('req-followup')).toEqual({
      messageId: 'answer-previous',
      preview: '贵州茅台当前估值仍需结合利润增长判断。',
    })

    setActivePinia(createPinia())
    const restored = useChatStore()
    expect(restored.conversationsByRole.stock_expert[0].messages[0]).toMatchObject({
      type: 'text',
      replyTo: { messageId: 'answer-previous' },
    })
  })
})
