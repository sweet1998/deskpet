import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { normalizeRoleId, type RoleId } from '../../shared/roles'

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

export const useChatStore = defineStore('chat', () => {
  const messagesByRole = ref<Record<RoleId, ChatMessage[]>>({
    default: [],
    stock_expert: [],
  })
  const activeRole = ref<RoleId>('default')
  const requestRoleById = ref<Record<string, RoleId>>({})
  const messages = computed(() => messagesByRole.value[activeRole.value])
  const bubbleVisible = ref(false)

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
  }
})
