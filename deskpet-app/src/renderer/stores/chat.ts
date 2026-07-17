import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

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
  const messages = ref<ChatMessage[]>([])
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

  function addUserMessage(text: string) {
    messages.value.push({
      id: `user-${Date.now()}`,
      role: 'user',
      text,
      streaming: false,
      timestamp: Date.now(),
      type: 'text',
    })
  }

  function appendChatText(delta: string, requestId: string) {
    bubbleVisible.value = true
    const existing = messages.value.find((m) => m.id === requestId)
    if (existing?.type === 'text') {
      existing.text += delta
    } else {
      messages.value.push({
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
    const msg = messages.value.find((m) => m.id === requestId)
    if (msg?.type === 'text') msg.streaming = false
  }

  function showChatMessage(text: string) {
    bubbleVisible.value = true
    messages.value.push({
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      text,
      streaming: false,
      timestamp: Date.now(),
      type: 'text',
    })
  }

  function addEmojiMessage(base64: string, description: string) {
    bubbleVisible.value = true
    messages.value.push({
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
    bubbleVisible,
    chatBubble,
    addUserMessage,
    addEmojiMessage,
    appendChatText,
    finishChatStream,
    showChatMessage,
    hideChatBubble,
  }
})
