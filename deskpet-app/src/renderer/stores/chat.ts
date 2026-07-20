import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { normalizeRoleId, type RoleId } from '../../shared/roles'

export type ChatStatusCode = 'timeout' | 'network' | 'service' | 'cancelled'

export interface ChatAttachment {
  id: string
  name: string
  mimeType: string
  size: number
}

export interface ChatReplyReference {
  messageId: string
  preview: string
}

export interface ChatMarketItem {
  code?: string
  name: string
  price: number | null
  changePercent: number | null
}

export interface ChatMarketCard {
  title: string
  items: ChatMarketItem[]
  asOf?: string
  source?: string
  note?: string
}

export type ChatMessage =
  | {
      id: string
      role: 'user' | 'assistant'
      text: string
      streaming: boolean
      timestamp: number
      type: 'text'
      attachments?: ChatAttachment[]
      replyTo?: ChatReplyReference
    }
  | {
      id: string
      role: 'assistant'
      base64: string
      description: string
      timestamp: number
      type: 'emoji'
    }
  | {
      id: string
      requestId: string
      role: 'assistant'
      steps: Array<{ id: string; text: string; timestamp: number }>
      collapsed: boolean
      complete: boolean
      timestamp: number
      type: 'thought'
    }
  | {
      id: string
      requestId: string
      role: 'assistant'
      text: string
      code: ChatStatusCode
      retryable: boolean
      timestamp: number
      type: 'status'
    }
  | {
      id: string
      requestId: string
      role: 'assistant'
      card: ChatMarketCard
      timestamp: number
      type: 'market'
    }

export interface ChatConversation {
  id: string
  roleId: RoleId
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

const LEGACY_HISTORY_KEY = 'deskpet/chat-history-v1'
const LEGACY_DRAFTS_KEY = 'deskpet/chat-drafts-v1'
const CONVERSATIONS_KEY = 'deskpet/chat-conversations-v2'
const ACTIVE_CONVERSATIONS_KEY = 'deskpet/chat-active-conversations-v2'
const DRAFTS_KEY = 'deskpet/chat-conversation-drafts-v2'
const MESSAGE_LIMIT = 200
const CONVERSATION_LIMIT = 40

function createId(prefix: string): string {
  return typeof crypto.randomUUID === 'function'
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function readStoredObject(key: string): Record<string, unknown> {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function sanitizeAttachment(value: unknown, index: number): ChatAttachment | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.name !== 'string' || !item.name.trim()) return null
  return {
    id: typeof item.id === 'string' ? item.id : `stored-attachment-${index}`,
    name: item.name.slice(0, 180),
    mimeType: typeof item.mimeType === 'string' ? item.mimeType.slice(0, 120) : 'application/octet-stream',
    size: typeof item.size === 'number' && item.size >= 0 ? item.size : 0,
  }
}

function sanitizeReplyReference(value: unknown): ChatReplyReference | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (typeof item.messageId !== 'string' || !item.messageId) return undefined
  if (typeof item.preview !== 'string' || !item.preview.trim()) return undefined
  return { messageId: item.messageId, preview: item.preview.trim().slice(0, 180) }
}

function sanitizeMarketCard(value: unknown): ChatMarketCard | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const items: ChatMarketItem[] = Array.isArray(item.items)
    ? item.items.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const market = raw as Record<string, unknown>
      if (typeof market.name !== 'string' || !market.name.trim()) return []
      return [{
        ...(typeof market.code === 'string' && market.code ? { code: market.code } : {}),
        name: market.name.slice(0, 60),
        price: typeof market.price === 'number' && Number.isFinite(market.price) ? market.price : null,
        changePercent: typeof market.changePercent === 'number' && Number.isFinite(market.changePercent)
          ? market.changePercent
          : null,
      }]
    }).slice(0, 8)
    : []
  if (!items.length) return null
  return {
    title: typeof item.title === 'string' && item.title.trim() ? item.title.slice(0, 80) : '行情快照',
    items,
    ...(typeof item.asOf === 'string' && item.asOf ? { asOf: item.asOf.slice(0, 80) } : {}),
    ...(typeof item.source === 'string' && item.source ? { source: item.source.slice(0, 80) } : {}),
    ...(typeof item.note === 'string' && item.note ? { note: item.note.slice(0, 160) } : {}),
  }
}

function sanitizeStoredMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const role = item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : null
  const id = typeof item.id === 'string' ? item.id : ''
  const timestamp = typeof item.timestamp === 'number' ? item.timestamp : Date.now()
  if (!id || !role) return null
  if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
    const attachments = Array.isArray(item.attachments)
      ? item.attachments.map(sanitizeAttachment).filter((entry): entry is ChatAttachment => Boolean(entry))
      : []
    const replyTo = sanitizeReplyReference(item.replyTo)
    return {
      id,
      role,
      text: item.text,
      streaming: false,
      timestamp,
      type: 'text',
      ...(attachments.length ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
    }
  }
  if (item.type === 'thought' && role === 'assistant' && item.complete === true) {
    const requestId = typeof item.requestId === 'string' ? item.requestId : ''
    const steps = Array.isArray(item.steps)
      ? item.steps.flatMap((step, index) => {
        if (!step || typeof step !== 'object') return []
        const stored = step as Record<string, unknown>
        if (typeof stored.text !== 'string' || !stored.text.trim()) return []
        return [{
          id: typeof stored.id === 'string' ? stored.id : `${requestId}-stored-${index}`,
          text: stored.text,
          timestamp: typeof stored.timestamp === 'number' ? stored.timestamp : timestamp,
        }]
      })
      : []
    if (!requestId || !steps.length) return null
    return {
      id,
      requestId,
      role: 'assistant',
      steps,
      collapsed: item.collapsed !== false,
      complete: true,
      timestamp,
      type: 'thought',
    }
  }
  if (item.type === 'market' && role === 'assistant') {
    const requestId = typeof item.requestId === 'string' ? item.requestId : ''
    const card = sanitizeMarketCard(item.card)
    if (!requestId || !card) return null
    return { id, requestId, role: 'assistant', card, timestamp, type: 'market' }
  }
  return null
}

function emptyConversation(roleId: RoleId, now = Date.now()): ChatConversation {
  return {
    id: createId(`conversation-${roleId}`),
    roleId,
    title: '新对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
}

function sanitizeConversation(value: unknown, roleId: RoleId): ChatConversation | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id) return null
  const createdAt = typeof item.createdAt === 'number' ? item.createdAt : Date.now()
  const messages = Array.isArray(item.messages)
    ? item.messages.map(sanitizeStoredMessage).filter((entry): entry is ChatMessage => Boolean(entry)).slice(-MESSAGE_LIMIT)
    : []
  return {
    id: item.id,
    roleId,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.slice(0, 80) : '新对话',
    createdAt,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : createdAt,
    messages,
  }
}

function readConversations(): Record<RoleId, ChatConversation[]> {
  const stored = readStoredObject(CONVERSATIONS_KEY)
  const result = {} as Record<RoleId, ChatConversation[]>
  for (const roleId of ['default', 'stock_expert'] as const) {
    const conversations = Array.isArray(stored[roleId])
      ? stored[roleId]
        .map((item) => sanitizeConversation(item, roleId))
        .filter((entry): entry is ChatConversation => Boolean(entry))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, CONVERSATION_LIMIT)
      : []
    result[roleId] = conversations
  }

  if (result.default.length || result.stock_expert.length) {
    if (!result.default.length) result.default.push(emptyConversation('default'))
    if (!result.stock_expert.length) result.stock_expert.push(emptyConversation('stock_expert'))
    return result
  }

  const legacy = readStoredObject(LEGACY_HISTORY_KEY)
  for (const roleId of ['default', 'stock_expert'] as const) {
    const messages = Array.isArray(legacy[roleId])
      ? legacy[roleId].map(sanitizeStoredMessage).filter((entry): entry is ChatMessage => Boolean(entry)).slice(-MESSAGE_LIMIT)
      : []
    const conversation = emptyConversation(roleId)
    conversation.messages = messages
    conversation.title = titleFromMessages(messages)
    result[roleId] = [conversation]
  }
  return result
}

function titleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.type === 'text' && message.role === 'user')
  if (!first || first.type !== 'text') return '新对话'
  const normalized = first.text.replace(/\s+/g, ' ').trim()
  return normalized.length > 22 ? `${normalized.slice(0, 22)}…` : normalized || '新对话'
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp))
}

export const useChatStore = defineStore('chat', () => {
  const conversationsByRole = ref<Record<RoleId, ChatConversation[]>>(readConversations())
  const storedActive = readStoredObject(ACTIVE_CONVERSATIONS_KEY)
  const activeConversationByRole = ref<Record<RoleId, string>>({
    default: typeof storedActive.default === 'string'
      && conversationsByRole.value.default.some((item) => item.id === storedActive.default)
      ? storedActive.default
      : conversationsByRole.value.default[0].id,
    stock_expert: typeof storedActive.stock_expert === 'string'
      && conversationsByRole.value.stock_expert.some((item) => item.id === storedActive.stock_expert)
      ? storedActive.stock_expert
      : conversationsByRole.value.stock_expert[0].id,
  })
  const storedDrafts = readStoredObject(DRAFTS_KEY)
  const legacyDrafts = readStoredObject(LEGACY_DRAFTS_KEY)
  const draftsByConversation = ref<Record<string, string>>({})
  for (const roleId of ['default', 'stock_expert'] as const) {
    for (const conversation of conversationsByRole.value[roleId]) {
      const stored = storedDrafts[conversation.id]
      if (typeof stored === 'string') draftsByConversation.value[conversation.id] = stored.slice(0, 12000)
    }
    const activeId = activeConversationByRole.value[roleId]
    if (!(activeId in draftsByConversation.value) && typeof legacyDrafts[roleId] === 'string') {
      draftsByConversation.value[activeId] = String(legacyDrafts[roleId]).slice(0, 12000)
    }
  }

  const activeRole = ref<RoleId>('default')
  const requestRoleById = ref<Record<string, RoleId>>({})
  const requestConversationById = ref<Record<string, string>>({})
  const bubbleVisible = ref(false)

  function activeForRole(roleId: RoleId): ChatConversation {
    const normalized = normalizeRoleId(roleId)
    const conversations = conversationsByRole.value[normalized]
    const activeId = activeConversationByRole.value[normalized]
    return conversations.find((item) => item.id === activeId) ?? conversations[0]
  }

  const activeConversation = computed(() => activeForRole(activeRole.value))
  const conversations = computed(() => conversationsByRole.value[activeRole.value])
  const messages = computed(() => activeConversation.value.messages)
  const messagesByRole = computed<Record<RoleId, ChatMessage[]>>(() => ({
    default: activeForRole('default').messages,
    stock_expert: activeForRole('stock_expert').messages,
  }))
  const draftsByRole = computed<Record<RoleId, string>>(() => ({
    default: draftsByConversation.value[activeConversationByRole.value.default] || '',
    stock_expert: draftsByConversation.value[activeConversationByRole.value.stock_expert] || '',
  }))

  function persistActive() {
    localStorage.setItem(ACTIVE_CONVERSATIONS_KEY, JSON.stringify(activeConversationByRole.value))
  }

  function persistDrafts() {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(draftsByConversation.value))
  }

  function persistedMessages(conversation: ChatConversation): ChatMessage[] {
    return conversation.messages.filter((message) => (
      message.type === 'text' && !message.streaming
    ) || (
      message.type === 'thought' && message.complete
    ) || message.type === 'market').slice(-MESSAGE_LIMIT)
  }

  function persistMessages() {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify({
      default: conversationsByRole.value.default.slice(0, CONVERSATION_LIMIT).map((conversation) => ({
        ...conversation,
        messages: persistedMessages(conversation),
      })),
      stock_expert: conversationsByRole.value.stock_expert.slice(0, CONVERSATION_LIMIT).map((conversation) => ({
        ...conversation,
        messages: persistedMessages(conversation),
      })),
    }))
  }

  function touchConversation(conversation: ChatConversation, persist = false) {
    conversation.updatedAt = Date.now()
    const list = conversationsByRole.value[conversation.roleId]
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    if (persist) persistMessages()
  }

  function createConversation(roleId: RoleId = activeRole.value): ChatConversation {
    const normalized = normalizeRoleId(roleId)
    const current = activeForRole(normalized)
    if (!current.messages.length) {
      draftsByConversation.value[current.id] = ''
      activeConversationByRole.value[normalized] = current.id
      persistActive()
      persistDrafts()
      bubbleVisible.value = false
      return current
    }
    const conversation = emptyConversation(normalized)
    conversationsByRole.value[normalized].unshift(conversation)
    conversationsByRole.value[normalized] = conversationsByRole.value[normalized].slice(0, CONVERSATION_LIMIT)
    activeConversationByRole.value[normalized] = conversation.id
    draftsByConversation.value[conversation.id] = ''
    persistActive()
    persistDrafts()
    persistMessages()
    bubbleVisible.value = false
    return conversation
  }

  function setActiveConversation(conversationId: string, roleId: RoleId = activeRole.value): boolean {
    const normalized = normalizeRoleId(roleId)
    if (!conversationsByRole.value[normalized].some((item) => item.id === conversationId)) return false
    activeConversationByRole.value[normalized] = conversationId
    persistActive()
    bubbleVisible.value = false
    return true
  }

  function deleteConversation(conversationId: string, roleId: RoleId = activeRole.value): boolean {
    const normalized = normalizeRoleId(roleId)
    const list = conversationsByRole.value[normalized]
    const index = list.findIndex((item) => item.id === conversationId)
    if (index < 0) return false
    list.splice(index, 1)
    delete draftsByConversation.value[conversationId]
    if (!list.length) list.push(emptyConversation(normalized))
    if (activeConversationByRole.value[normalized] === conversationId) {
      activeConversationByRole.value[normalized] = list[Math.min(index, list.length - 1)].id
    }
    persistActive()
    persistDrafts()
    persistMessages()
    bubbleVisible.value = false
    return true
  }

  function setDraft(roleId: RoleId, text: string) {
    const normalized = normalizeRoleId(roleId)
    const conversationId = activeConversationByRole.value[normalized]
    draftsByConversation.value[conversationId] = text.slice(0, 12000)
    persistDrafts()
  }

  function clearDraft(roleId: RoleId) {
    setDraft(roleId, '')
  }

  const chatBubble = computed(() => {
    const last = [...messages.value].reverse().find(
      (message): message is Extract<ChatMessage, { type: 'text' }> =>
        message.role === 'assistant' && message.type === 'text',
    )
    return {
      text: last?.text || '',
      visible: Boolean(last && bubbleVisible.value),
      streaming: last?.streaming || false,
      requestId: last?.id || null,
    }
  })

  function setActiveRole(roleId: RoleId) {
    activeRole.value = normalizeRoleId(roleId)
  }

  function bindRequest(requestId: string, roleId: RoleId = activeRole.value) {
    if (!requestId) return
    const normalized = normalizeRoleId(roleId)
    requestRoleById.value[requestId] = normalized
    requestConversationById.value[requestId] = activeConversationByRole.value[normalized]
  }

  function requestConversation(requestId?: string): ChatConversation {
    const roleId = requestId ? requestRoleById.value[requestId] ?? activeRole.value : activeRole.value
    const conversationId = requestId ? requestConversationById.value[requestId] : undefined
    if (conversationId) {
      const bound = conversationsByRole.value[roleId].find((item) => item.id === conversationId)
      if (bound) return bound
    }
    return activeForRole(roleId)
  }

  function roleMessages(requestId?: string): ChatMessage[] {
    return requestConversation(requestId).messages
  }

  function getRequestRole(requestId: string): RoleId | undefined {
    return requestRoleById.value[requestId]
  }

  function getRequestMessages(requestId: string): ChatMessage[] {
    return roleMessages(requestId)
  }

  function getRequestConversationId(requestId: string): string | undefined {
    return requestConversationById.value[requestId]
  }

  function addUserMessage(
    text: string,
    requestId?: string,
    roleId: RoleId = activeRole.value,
    attachments: ChatAttachment[] = [],
    replyTo?: ChatReplyReference,
  ) {
    const normalizedRole = normalizeRoleId(roleId)
    if (requestId) bindRequest(requestId, normalizedRole)
    const conversation = requestConversation(requestId)
    conversation.messages.push({
      id: requestId ? `user-${requestId}` : createId('user'),
      role: 'user',
      text,
      streaming: false,
      timestamp: Date.now(),
      type: 'text',
      ...(attachments.length ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
    })
    if (conversation.title === '新对话') conversation.title = titleFromMessages(conversation.messages)
    touchConversation(conversation, true)
  }

  function findThought(requestId: string) {
    return roleMessages(requestId).find(
      (message): message is Extract<ChatMessage, { type: 'thought' }> =>
        message.type === 'thought' && message.requestId === requestId,
    )
  }

  function beginThought(requestId: string) {
    if (!requestId || findThought(requestId)) return
    const conversation = requestConversation(requestId)
    conversation.messages.push({
      id: `thought-${requestId}`,
      requestId,
      role: 'assistant',
      steps: [],
      collapsed: false,
      complete: false,
      timestamp: Date.now(),
      type: 'thought',
    })
    touchConversation(conversation)
  }

  function appendThought(requestId: string, text: string) {
    const normalized = text.trim()
    if (!normalized) return
    beginThought(requestId)
    const thought = findThought(requestId)
    if (!thought || thought.steps.at(-1)?.text === normalized) return
    thought.steps.push({
      id: `${requestId}-step-${thought.steps.length}`,
      text: normalized,
      timestamp: Date.now(),
    })
    touchConversation(requestConversation(requestId))
  }

  function finishThought(requestId: string) {
    const thought = findThought(requestId)
    if (!thought) return
    thought.complete = true
    thought.collapsed = true
    touchConversation(requestConversation(requestId), true)
  }

  function toggleThought(requestId: string) {
    const thought = findThought(requestId)
    if (thought) {
      thought.collapsed = !thought.collapsed
      if (thought.complete) persistMessages()
    }
  }

  function showMarketCard(requestId: string, card: ChatMarketCard) {
    if (!requestId || !card.items.length) return
    const conversation = requestConversation(requestId)
    const existing = conversation.messages.find((message) => message.id === `market-${requestId}`)
    if (existing?.type === 'market') {
      existing.card = card
    } else {
      conversation.messages.push({
        id: `market-${requestId}`,
        requestId,
        role: 'assistant',
        card,
        timestamp: Date.now(),
        type: 'market',
      })
    }
    touchConversation(conversation, true)
  }

  function showStatusMessage(
    requestId: string,
    text: string,
    code: ChatStatusCode = 'service',
    retryable = true,
  ) {
    if (!requestId || !text.trim()) return
    const conversation = requestConversation(requestId)
    const existing = conversation.messages.find((message) => message.id === `status-${requestId}`)
    if (existing?.type === 'status') {
      existing.text = text
      existing.code = code
      existing.retryable = retryable
      return
    }
    conversation.messages.push({
      id: `status-${requestId}`,
      requestId,
      role: 'assistant',
      text,
      code,
      retryable,
      timestamp: Date.now(),
      type: 'status',
    })
    touchConversation(conversation)
  }

  function getRequestText(requestId: string): string | undefined {
    const message = roleMessages(requestId).find((item) => item.id === `user-${requestId}`)
    return message?.type === 'text' ? message.text : undefined
  }

  function getRequestReplyTo(requestId: string): ChatReplyReference | undefined {
    const message = roleMessages(requestId).find((item) => item.id === `user-${requestId}`)
    return message?.type === 'text' ? message.replyTo : undefined
  }

  function appendChatText(delta: string, requestId: string) {
    if (!requestId || (
      getRequestRole(requestId) === activeRole.value
      && requestConversationById.value[requestId] === activeConversation.value.id
    )) bubbleVisible.value = true
    const conversation = requestConversation(requestId)
    const existing = conversation.messages.find((message) => message.id === requestId)
    if (existing?.type === 'text') {
      existing.text += delta
    } else {
      conversation.messages.push({
        id: requestId,
        role: 'assistant',
        text: delta,
        streaming: true,
        timestamp: Date.now(),
        type: 'text',
      })
    }
    touchConversation(conversation)
  }

  function finishChatStream(requestId: string) {
    const conversation = requestConversation(requestId)
    const message = conversation.messages.find((item) => item.id === requestId)
    if (message?.type === 'text') message.streaming = false
    touchConversation(conversation, true)
  }

  function showChatMessage(text: string, requestId?: string) {
    if (!requestId || (
      getRequestRole(requestId) === activeRole.value
      && requestConversationById.value[requestId] === activeConversation.value.id
    )) bubbleVisible.value = true
    const conversation = requestConversation(requestId)
    const existing = requestId
      ? conversation.messages.find((message) => message.id === requestId)
      : undefined
    if (existing?.type === 'text') {
      existing.text = text
      existing.streaming = false
    } else {
      conversation.messages.push({
        id: requestId || createId('assistant'),
        role: 'assistant',
        text,
        streaming: false,
        timestamp: Date.now(),
        type: 'text',
      })
    }
    touchConversation(conversation, true)
  }

  function addEmojiMessage(base64: string, description: string, requestId?: string) {
    const conversation = requestConversation(requestId)
    if (!requestId || (
      getRequestRole(requestId) === activeRole.value
      && requestConversationById.value[requestId] === activeConversation.value.id
    )) bubbleVisible.value = true
    conversation.messages.push({
      id: createId('emoji'),
      role: 'assistant',
      base64,
      description,
      timestamp: Date.now(),
      type: 'emoji',
    })
    touchConversation(conversation)
  }

  function exportConversationMarkdown(conversationId: string): { title: string; content: string } | null {
    const conversation = conversationsByRole.value[activeRole.value].find((item) => item.id === conversationId)
    if (!conversation) return null
    const profileName = conversation.roleId === 'stock_expert' ? '炒股专家' : '麦麦'
    const lines = [
      `# ${conversation.title}`,
      '',
      `> 角色：${profileName}  ·  更新时间：${formatTime(conversation.updatedAt)}`,
      '',
    ]
    for (const message of conversation.messages) {
      if (message.type === 'text') {
        lines.push(`## ${message.role === 'user' ? '我' : profileName}`, '', message.text, '')
        if (message.replyTo) lines.push(`> 追问：${message.replyTo.preview}`, '')
        if (message.attachments?.length) {
          lines.push(`附件：${message.attachments.map((item) => item.name).join('、')}`, '')
        }
      } else if (message.type === 'thought' && message.steps.length) {
        lines.push('> 分析记录', ...message.steps.map((step) => `> - ${step.text}`), '')
      } else if (message.type === 'market') {
        lines.push(`### ${message.card.title}`, '')
        for (const item of message.card.items) {
          const price = item.price == null ? '--' : String(item.price)
          const change = item.changePercent == null ? '--' : `${item.changePercent >= 0 ? '+' : ''}${item.changePercent}%`
          lines.push(`- ${item.name}${item.code ? `（${item.code}）` : ''}：${price}，${change}`)
        }
        lines.push('')
      }
    }
    return { title: conversation.title, content: lines.join('\n').trim() }
  }

  function hideChatBubble() {
    bubbleVisible.value = false
  }

  persistMessages()
  persistActive()

  return {
    messages,
    messagesByRole,
    conversations,
    conversationsByRole,
    activeConversation,
    activeConversationByRole,
    draftsByRole,
    draftsByConversation,
    activeRole,
    requestRoleById,
    requestConversationById,
    bubbleVisible,
    chatBubble,
    createConversation,
    setActiveConversation,
    deleteConversation,
    exportConversationMarkdown,
    addUserMessage,
    addEmojiMessage,
    appendChatText,
    finishChatStream,
    showChatMessage,
    showMarketCard,
    hideChatBubble,
    setActiveRole,
    bindRequest,
    getRequestRole,
    getRequestMessages,
    getRequestConversationId,
    beginThought,
    appendThought,
    finishThought,
    toggleThought,
    showStatusMessage,
    getRequestText,
    getRequestReplyTo,
    setDraft,
    clearDraft,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
