import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chat'

describe('chat store roles', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
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

  it('does not expose or persist an empty conversation as history', () => {
    const chat = useChatStore()
    const initialId = chat.activeConversation.id

    const first = chat.createConversation('default')
    const second = chat.createConversation('default')

    expect(first.id).toBe(initialId)
    expect(second.id).toBe(initialId)
    expect(chat.conversations).toEqual([])
    expect(JSON.parse(localStorage.getItem('deskpet/chat-conversations-v2') || '{}').default).toEqual([])

    chat.addUserMessage('真正开始对话', 'req-started', 'default')
    expect(chat.conversations).toHaveLength(1)
  })

  it('drops empty conversations restored from old history', () => {
    localStorage.setItem('deskpet/chat-conversations-v2', JSON.stringify({
      default: [{
        id: 'empty-default', roleId: 'default', title: '新对话', createdAt: 1, updatedAt: 1, messages: [],
      }],
      stock_expert: [],
    }))
    setActivePinia(createPinia())

    const restored = useChatStore()

    expect(restored.conversations).toEqual([])
    expect(restored.activeConversation.messages).toEqual([])
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

  it('shows the same market target only once per conversation', () => {
    const chat = useChatStore()
    const innovationDrug = {
      title: '创新药行情',
      items: [{ code: '308014', name: '创新药', price: null, changePercent: -4.07 }],
    }

    chat.addUserMessage('创新药行情怎么样', 'req-market-first', 'stock_expert')
    chat.showMarketCard('req-market-first', innovationDrug)
    chat.addUserMessage('上涨的是哪几家', 'req-market-followup', 'stock_expert')
    chat.showMarketCard('req-market-followup', { ...innovationDrug, asOf: '2026-07-24T15:27:00+08:00' })

    const cards = chat.messagesByRole.stock_expert.filter((message) => message.type === 'market')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ requestId: 'req-market-first' })
  })

  it('still shows a market card for a different target', () => {
    const chat = useChatStore()
    chat.addUserMessage('创新药行情怎么样', 'req-sector', 'stock_expert')
    chat.showMarketCard('req-sector', {
      title: '创新药行情',
      items: [{ code: '308014', name: '创新药', price: null, changePercent: -4.07 }],
    })
    chat.addUserMessage('茅台现在多少钱', 'req-stock', 'stock_expert')
    chat.showMarketCard('req-stock', {
      title: '个股行情',
      items: [{ code: '600519', name: '贵州茅台', price: 1400, changePercent: 1.2 }],
    })

    expect(chat.messagesByRole.stock_expert.filter((message) => message.type === 'market')).toHaveLength(2)
  })

  it('removes duplicate market targets when restoring existing history', () => {
    const card = {
      title: '创新药行情',
      items: [{ code: '308014', name: '创新药', price: null, changePercent: -4.07 }],
    }
    localStorage.setItem('deskpet/chat-conversations-v2', JSON.stringify({
      default: [],
      stock_expert: [{
        id: 'conversation-stock', roleId: 'stock_expert', title: '创新药', createdAt: 1, updatedAt: 2,
        messages: [
          {
            id: 'user-first', role: 'user', text: '创新药行情怎么样', streaming: false,
            timestamp: 1, type: 'text', inputKind: 'text',
          },
          { id: 'market-first', requestId: 'first', role: 'assistant', card, timestamp: 1, type: 'market' },
          { id: 'market-second', requestId: 'second', role: 'assistant', card, timestamp: 2, type: 'market' },
        ],
      }],
    }))
    setActivePinia(createPinia())

    const restored = useChatStore()

    expect(restored.messagesByRole.stock_expert.filter((message) => message.type === 'market')).toHaveLength(1)
    expect(restored.messagesByRole.stock_expert[1]).toMatchObject({ requestId: 'first' })
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

  it('captures the previous conversation before adding a direct follow-up', () => {
    const chat = useChatStore()
    chat.addUserMessage('最近科技板块怎么样', 'req-sector', 'stock_expert')
    chat.appendChatText('科技板块近期整体回调，现有数据没有覆盖消息面。', 'req-sector')
    chat.finishChatStream('req-sector')

    chat.addUserMessage('为什么你手上的数据没有覆盖消息面', 'req-direct-followup', 'stock_expert')

    expect(chat.getRequestHistory('req-direct-followup')).toEqual([
      { role: 'user', content: '最近科技板块怎么样' },
      { role: 'assistant', content: '科技板块近期整体回调，现有数据没有覆盖消息面。' },
    ])
  })

  it('includes an explicitly referenced answer when it is outside recent history', () => {
    const chat = useChatStore()
    for (let index = 0; index < 22; index += 1) {
      chat.addUserMessage(`问题 ${index}`, `req-history-${index}`, 'stock_expert')
    }

    chat.addUserMessage('这个判断的依据是什么', 'req-old-reference', 'stock_expert', [], {
      messageId: 'answer-old',
      preview: '这是较早回答中的关键判断。',
    })

    const history = chat.getRequestHistory('req-old-reference')
    expect(history).toHaveLength(20)
    expect(history.at(-1)).toEqual({ role: 'assistant', content: '这是较早回答中的关键判断。' })
  })

  it('keeps native input kinds so retries use the original workflow', () => {
    const chat = useChatStore()
    chat.addUserMessage('分析当前屏幕', 'req-screen', 'default', [], undefined, 'screenshot')
    chat.addUserMessage('分析附件', 'req-file', 'default', [], undefined, 'file')

    expect(chat.getRequestInputKind('req-screen')).toBe('screenshot')
    expect(chat.canRetryRequest('req-screen')).toBe(true)
    expect(chat.canRetryRequest('req-file')).toBe(true)

    setActivePinia(createPinia())
    const restored = useChatStore()
    expect(restored.conversationsByRole.default[0].messages[0]).toMatchObject({ inputKind: 'screenshot' })
  })

  it('clears only the assistant output when regenerating a request', () => {
    const chat = useChatStore()
    chat.addUserMessage('重新分析附件', 'req-retry', 'default', [{
      id: 'file-retry', name: 'report.pdf', mimeType: 'application/pdf', size: 2048,
    }], undefined, 'file')
    chat.appendThought('req-retry', '正在读取附件')
    chat.showMarketCard('req-retry', {
      title: '附件数据',
      items: [{ name: '示例', price: 1, changePercent: 0 }],
    })
    chat.appendChatText('旧回答', 'req-retry')
    chat.finishChatStream('req-retry')
    chat.showStatusMessage('req-retry', '旧错误', 'service')

    expect(chat.resetRequestResponse('req-retry')).toBe(true)
    expect(chat.messages).toEqual([
      expect.objectContaining({
        id: 'user-req-retry',
        text: '重新分析附件',
        attachments: [expect.objectContaining({ name: 'report.pdf' })],
      }),
    ])
    expect(chat.resetRequestResponse('req-retry')).toBe(false)
  })

  it('marks a truncated answer so the user can continue it', () => {
    const chat = useChatStore()
    chat.addUserMessage('详细分析医药板块', 'req-truncated')
    chat.appendChatText('回答到一半', 'req-truncated')
    chat.finishChatStream('req-truncated')

    chat.markChatTruncated('req-truncated')
    expect(chat.messages.find((message) => message.id === 'req-truncated')).toMatchObject({
      type: 'text',
      truncated: true,
    })

    chat.markChatTruncated('req-truncated', false)
    expect(chat.messages.find((message) => message.id === 'req-truncated')).toMatchObject({
      type: 'text',
      truncated: false,
    })
  })

  it('uses an isolated non-persistent conversation in privacy mode', () => {
    const chat = useChatStore()
    chat.addUserMessage('普通历史', 'req-normal')
    chat.setPrivacyMode(true)
    chat.addUserMessage('私人内容', 'req-private')

    expect(chat.messages.some((message) => message.type === 'text' && message.text === '私人内容')).toBe(true)
    expect(localStorage.getItem('deskpet/chat-conversations-v2')).not.toContain('私人内容')

    chat.setPrivacyMode(false)
    expect(chat.messages.some((message) => message.type === 'text' && message.text === '普通历史')).toBe(true)
    expect(chat.messages.some((message) => message.type === 'text' && message.text === '私人内容')).toBe(false)
  })

  it('clears persisted conversations and drafts for every role', async () => {
    const chat = useChatStore()
    chat.addUserMessage('需要删除', 'req-delete')
    chat.setDraft('stock_expert', '草稿')

    await chat.clearAllConversations()

    expect(chat.conversationsByRole.default[0].messages).toEqual([])
    expect(chat.conversationsByRole.stock_expert[0].messages).toEqual([])
    expect(localStorage.getItem('deskpet/chat-conversations-v2')).toBeNull()
    expect(localStorage.getItem('deskpet/chat-conversation-drafts-v2')).toBeNull()
  })

  it('migrates plaintext conversation data only after encrypted persistence succeeds', async () => {
    const writeSecureUserData = vi.fn(async (_namespace: string, value: unknown) => {
      expect(() => structuredClone(value)).not.toThrow()
      return true
    })
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        readSecureUserData: vi.fn().mockResolvedValue({ available: true, exists: false }),
        writeSecureUserData,
      },
    })
    const chat = useChatStore()
    chat.addUserMessage('需要加密的内容', 'req-secure')

    await expect(chat.hydrateSecureStorage()).resolves.toBe(true)

    expect(chat.storageProtected).toBe(true)
    expect(localStorage.getItem('deskpet/chat-conversations-v2')).toBeNull()
    expect(writeSecureUserData).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({
        version: 1,
        conversations: expect.objectContaining({
          default: expect.arrayContaining([
            expect.objectContaining({ messages: expect.arrayContaining([
              expect.objectContaining({ text: '需要加密的内容' }),
            ]) }),
          ]),
        }),
      }),
    )
  })

  it('persists the normal snapshot when privacy mode replaces the visible conversation', async () => {
    vi.useFakeTimers()
    const writeSecureUserData = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        readSecureUserData: vi.fn().mockResolvedValue({ available: true, exists: false }),
        writeSecureUserData,
        clearSecureUserData: vi.fn().mockResolvedValue(true),
      },
    })
    const chat = useChatStore()
    await chat.hydrateSecureStorage()
    writeSecureUserData.mockClear()

    chat.addUserMessage('必须保留的正常历史', 'req-before-private')
    chat.setPrivacyMode(true)
    await vi.runAllTimersAsync()

    expect(writeSecureUserData).toHaveBeenLastCalledWith(
      'chat',
      expect.objectContaining({
        conversations: expect.objectContaining({
          default: expect.arrayContaining([
            expect.objectContaining({
              messages: expect.arrayContaining([
                expect.objectContaining({ text: '必须保留的正常历史' }),
              ]),
            }),
          ]),
        }),
      }),
    )
    vi.useRealTimers()
  })

  it('clears encrypted normal history even while privacy mode is active', async () => {
    const clearSecureUserData = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        readSecureUserData: vi.fn().mockResolvedValue({ available: true, exists: false }),
        writeSecureUserData: vi.fn().mockResolvedValue(true),
        clearSecureUserData,
      },
    })
    const chat = useChatStore()
    await chat.hydrateSecureStorage()
    chat.addUserMessage('清空后不可恢复', 'req-clear-private')
    chat.setPrivacyMode(true)

    await expect(chat.clearAllConversations()).resolves.toBe(true)
    chat.setPrivacyMode(false)

    expect(clearSecureUserData).toHaveBeenCalledWith('chat')
    expect(chat.messages).toEqual([])
  })

  it('keeps encrypted normal history hidden when the app starts in privacy mode', async () => {
    localStorage.setItem('deskpet/privacy-mode', 'true')
    const stored = {
      version: 1,
      conversations: {
        default: [{
          id: 'normal-default', roleId: 'default', title: '正常历史', createdAt: 1, updatedAt: 1,
          messages: [{
            id: 'user-normal', role: 'user', text: '重启后仍需隐藏', streaming: false,
            timestamp: 1, type: 'text', inputKind: 'text',
          }],
        }],
        stock_expert: [{
          id: 'normal-stock', roleId: 'stock_expert', title: '新对话', createdAt: 1, updatedAt: 1, messages: [],
        }],
      },
      active: { default: 'normal-default', stock_expert: 'normal-stock' },
      drafts: {},
    }
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        readSecureUserData: vi.fn().mockResolvedValue({ available: true, exists: true, value: stored }),
        writeSecureUserData: vi.fn().mockResolvedValue(true),
        clearSecureUserData: vi.fn().mockResolvedValue(true),
      },
    })
    const chat = useChatStore()

    await chat.hydrateSecureStorage()
    expect(chat.messages).toEqual([])

    chat.setPrivacyMode(false)
    expect(chat.messages).toEqual([expect.objectContaining({ text: '重启后仍需隐藏' })])
  })
})
