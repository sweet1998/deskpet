import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { normalizeRoleId, type RoleId } from '../../shared/roles'

export type ChatStatusCode = 'timeout' | 'network' | 'service' | 'cancelled'

export type ChatMessage =
  | {
      id: string
      role: 'user' | 'assistant'
      text: string
      streaming: boolean
      timestamp: number
      type: 'text'
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

const HISTORY_KEY = 'deskpet/chat-history-v1'
const DRAFTS_KEY = 'deskpet/chat-drafts-v1'
const HISTORY_LIMIT = 100

function readStoredObject(key: string): Record<string, unknown> {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
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
    return { id, role, text: item.text, streaming: false, timestamp, type: 'text' }
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
  return null
}

function readStoredMessages(): Record<RoleId, ChatMessage[]> {
  const stored = readStoredObject(HISTORY_KEY)
  const readRole = (roleId: RoleId) => (
    Array.isArray(stored[roleId])
      ? stored[roleId].map(sanitizeStoredMessage).filter((item): item is ChatMessage => Boolean(item)).slice(-HISTORY_LIMIT)
      : []
  )
  return { default: readRole('default'), stock_expert: readRole('stock_expert') }
}

function readStoredDrafts(): Record<RoleId, string> {
  const stored = readStoredObject(DRAFTS_KEY)
  return {
    default: typeof stored.default === 'string' ? stored.default.slice(0, 4000) : '',
    stock_expert: typeof stored.stock_expert === 'string' ? stored.stock_expert.slice(0, 4000) : '',
  }
}

export const useChatStore = defineStore('chat', () => {
  const messagesByRole = ref<Record<RoleId, ChatMessage[]>>(readStoredMessages())
  const draftsByRole = ref<Record<RoleId, string>>(readStoredDrafts())
  const activeRole = ref<RoleId>('default')
  const requestRoleById = ref<Record<string, RoleId>>({})
  const messages = computed(() => messagesByRole.value[activeRole.value])
  const bubbleVisible = ref(false)

  function persistMessages() {
    const persistRole = (roleId: RoleId) => messagesByRole.value[roleId]
      .filter((message) => (
        message.type === 'text' && !message.streaming
      ) || (
        message.type === 'thought' && message.complete
      ))
      .slice(-HISTORY_LIMIT)
    localStorage.setItem(HISTORY_KEY, JSON.stringify({
      default: persistRole('default'),
      stock_expert: persistRole('stock_expert'),
    }))
  }

  function setDraft(roleId: RoleId, text: string) {
    draftsByRole.value[normalizeRoleId(roleId)] = text.slice(0, 4000)
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(draftsByRole.value))
  }

  function clearDraft(roleId: RoleId) {
    setDraft(roleId, '')
  }

  // backward-compat: last assistant bubble
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
    if (requestId) requestRoleById.value[requestId] = normalizeRoleId(roleId)
  }

  function roleMessages(requestId?: string): ChatMessage[] {
    const roleId = requestId ? requestRoleById.value[requestId] ?? activeRole.value : activeRole.value
    return messagesByRole.value[roleId]
  }

  function getRequestRole(requestId: string): RoleId | undefined {
    return requestRoleById.value[requestId]
  }

  function addUserMessage(text: string, requestId?: string, roleId: RoleId = activeRole.value) {
    const normalizedRole = normalizeRoleId(roleId)
    if (requestId) bindRequest(requestId, normalizedRole)
    messagesByRole.value[normalizedRole].push({
      id: requestId ? `user-${requestId}` : `user-${Date.now()}`,
      role: 'user',
      text,
      streaming: false,
      timestamp: Date.now(),
      type: 'text',
    })
    persistMessages()
  }

  function findThought(requestId: string) {
    return roleMessages(requestId).find(
      (message): message is Extract<ChatMessage, { type: 'thought' }> =>
        message.type === 'thought' && message.requestId === requestId,
    )
  }

  function beginThought(requestId: string) {
    if (!requestId || findThought(requestId)) return
    roleMessages(requestId).push({
      id: `thought-${requestId}`,
      requestId,
      role: 'assistant',
      steps: [],
      collapsed: false,
      complete: false,
      timestamp: Date.now(),
      type: 'thought',
    })
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
  }

  function finishThought(requestId: string) {
    const thought = findThought(requestId)
    if (!thought) return
    thought.complete = true
    thought.collapsed = true
    persistMessages()
  }

  function toggleThought(requestId: string) {
    const thought = findThought(requestId)
    if (thought) {
      thought.collapsed = !thought.collapsed
      if (thought.complete) persistMessages()
    }
  }

  function showStatusMessage(
    requestId: string,
    text: string,
    code: ChatStatusCode = 'service',
    retryable = true,
  ) {
    if (!requestId || !text.trim()) return
    const target = roleMessages(requestId)
    const existing = target.find((message) => message.id === `status-${requestId}`)
    if (existing?.type === 'status') {
      existing.text = text
      existing.code = code
      existing.retryable = retryable
      return
    }
    target.push({
      id: `status-${requestId}`,
      requestId,
      role: 'assistant',
      text,
      code,
      retryable,
      timestamp: Date.now(),
      type: 'status',
    })
  }

  function getRequestText(requestId: string): string | undefined {
    const message = roleMessages(requestId).find((item) => item.id === `user-${requestId}`)
    return message?.type === 'text' ? message.text : undefined
  }

  function appendChatText(delta: string, requestId: string) {
    if (!requestId || getRequestRole(requestId) === activeRole.value) bubbleVisible.value = true
    const target = roleMessages(requestId)
    const existing = target.find((m) => m.id === requestId)
    if (existing?.type === 'text') {
      existing.text += delta
    } else {
      target.push({
        id: requestId,
        role: 'assistant',
        text: delta,
        streaming: true,
        timestamp: Date.now(),
        type: 'text',
      })
    }
  }

  function finishChatStream(requestId: string) {
    const msg = roleMessages(requestId).find((m) => m.id === requestId)
    if (msg?.type === 'text') msg.streaming = false
    persistMessages()
  }

  function showChatMessage(text: string, requestId?: string) {
    if (!requestId || getRequestRole(requestId) === activeRole.value) bubbleVisible.value = true
    roleMessages(requestId).push({
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      text,
      streaming: false,
      timestamp: Date.now(),
      type: 'text',
    })
    persistMessages()
  }

  function addEmojiMessage(base64: string, description: string, requestId?: string) {
    if (!requestId || getRequestRole(requestId) === activeRole.value) bubbleVisible.value = true
    roleMessages(requestId).push({
      id: `emoji-${Date.now()}`,
      role: 'assistant',
      base64,
      description,
      timestamp: Date.now(),
      type: 'emoji',
    })
  }

  function hideChatBubble() {
    bubbleVisible.value = false
  }

  return {
    messages,
    messagesByRole,
    draftsByRole,
    activeRole,
    requestRoleById,
    bubbleVisible,
    chatBubble,
    addUserMessage,
    addEmojiMessage,
    appendChatText,
    finishChatStream,
    showChatMessage,
    hideChatBubble,
    setActiveRole,
    bindRequest,
    getRequestRole,
    beginThought,
    appendThought,
    finishThought,
    toggleThought,
    showStatusMessage,
    getRequestText,
    setDraft,
    clearDraft,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChatStore, import.meta.hot))
}
