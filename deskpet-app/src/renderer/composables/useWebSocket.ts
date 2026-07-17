import { ref, onMounted, onUnmounted } from 'vue'
import { useDeskpetStore } from '@/stores/deskpet'
import { useChatStore } from '@/stores/chat'
import { useAgentStore } from '@/stores/agent'
import { useLipSync } from './useLipSync'
import { isDeskpetEmotionValue } from '@/services/live2d/emotion-adapter'
import { isAgentState } from '@/services/agent-protocol'
import type { AgentConfirmation, AgentTaskResult } from '@/services/agent-protocol'
import { getAiProvider } from '@/services/ai-provider'

function getWsUrl(): string {
  try {
    const custom = localStorage.getItem('deskpet/ws-url')
    if (custom) return custom
  } catch { /* localStorage blocked */ }
  return 'ws://127.0.0.1:8523/ws'
}

function getWsToken(): string {
  try {
    return localStorage.getItem('deskpet/ws-token') || ''
  } catch { return '' }
}

interface WSMessage {
  type: string
  data: any
  timestamp?: number
  request_id?: string
}

export function useWebSocket() {
  const url = getWsUrl()
  const token = getWsToken()
  const store = useDeskpetStore()
  const chatStore = useChatStore()
  const agentStore = useAgentStore()
  const { start: startLipSync, stop: stopLipSync } = useLipSync()

  let currentAudio: HTMLAudioElement | null = null
  let currentAudioUrl: string | null = null
  let audioQueue: string[] = []

  function playNextInQueue() {
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl)
    currentAudioUrl = null
    currentAudio = null
    if (audioQueue.length === 0) return
    const b64 = audioQueue.shift()!
    playAudioNow(b64)
  }

  function playAudioNow(base64: string) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: 'audio/wav' })
    currentAudioUrl = URL.createObjectURL(blob)
    const audio = new Audio(currentAudioUrl)
    currentAudio = audio
    startLipSync()
    audio.onended = () => { stopLipSync(); playNextInQueue() }
    audio.onerror = () => { stopLipSync(); playNextInQueue() }
    audio.play()
  }

  function stopOutput() {
    audioQueue = []
    currentAudio?.pause()
    currentAudio = null
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl)
    currentAudioUrl = null
    stopLipSync()
  }

  function playAudio(base64: string) {
    if (currentAudio) {
      audioQueue.push(base64)
      return
    }
    playAudioNow(base64)
  }

  const ws = ref<WebSocket | null>(null)
  const heartbeatTimer = ref<ReturnType<typeof setInterval> | null>(null)
  const reconnectTimer = ref<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttempt = ref(0)
  const maxReconnectDelay = 30000

  function connect() {
    if (ws.value?.readyState === WebSocket.OPEN) return

    try {
      ws.value = new WebSocket(url)
    } catch (e) {
      console.warn('[Deskpet] WebSocket connect failed, retrying...')
      scheduleReconnect()
      return
    }

    ws.value.onopen = () => {
      console.log('[Deskpet] WebSocket connected')
      store.wsConnected = true
      if (token) send('auth', { token })
      reconnectAttempt.value = 0
      startHeartbeat()
    }

    ws.value.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        handleMessage(msg)
      } catch (e) {
        console.warn('[Deskpet] Failed to parse message:', e)
      }
    }

    ws.value.onclose = () => {
      console.log('[Deskpet] WebSocket disconnected')
      store.wsConnected = false
      stopHeartbeat()
      scheduleReconnect()
    }

    ws.value.onerror = () => {
      ws.value?.close()
    }
  }

  function handleMessage(msg: WSMessage) {
    const { type, data, request_id } = msg

    switch (type) {
      case 'output:text:delta':
        chatStore.appendChatText(data.delta, request_id || data.request_id || '')
        if (agentStore.state !== 'executing') {
          agentStore.applyState({
            requestId: request_id || data.request_id || agentStore.activeRequestId,
            state: 'speaking',
            interruptible: true,
          })
        }
        break

      case 'output:text:done':
        chatStore.finishChatStream(request_id || data.request_id || '')
        if (!data.error) {
          setTimeout(() => chatStore.hideChatBubble(), 8000)
        } else {
          agentStore.applyState({
            requestId: request_id || data.request_id || agentStore.activeRequestId,
            state: 'error',
            error: data.error,
          })
        }
        break

      case 'output:text':
        chatStore.showChatMessage(data.text)
        setTimeout(() => chatStore.hideChatBubble(), 8000)
        break

      case 'state:emotion':
        if (isDeskpetEmotionValue(data.emotion)) {
          store.currentEmotion = data.emotion
        } else {
          console.debug('[Deskpet] Ignore unknown emotion:', data.emotion)
        }
        break

      case 'state:animation':
        store.pendingAnimation = data.name
        store.pendingAnimationLoop = !!data.loop
        break

      case 'output:audio':
        if (data.base64) playAudio(data.base64)
        break

      case 'state:thinking':
        store.isThinking = true
        agentStore.applyState({
          requestId: request_id || data.request_id || agentStore.activeRequestId,
          state: 'thinking',
          step: '正在理解你的请求',
          interruptible: true,
        })
        break

      case 'state:agent':
        if (isAgentState(data.state)) {
          agentStore.applyState({
            requestId: request_id || data.requestId || data.request_id || agentStore.activeRequestId,
            state: data.state,
            progress: typeof data.progress === 'number' ? data.progress : undefined,
            step: typeof data.step === 'string' ? data.step : undefined,
            interruptible: Boolean(data.interruptible),
            error: typeof data.error === 'string' ? data.error : undefined,
          })
        }
        break

      case 'tool:confirmation':
        agentStore.setConfirmation({
          requestId: request_id || data.requestId || data.request_id || '',
          tool: String(data.tool || ''),
          summary: String(data.summary || ''),
          risk: ['low', 'medium', 'high'].includes(data.risk) ? data.risk : 'medium',
          expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : undefined,
        } as AgentConfirmation)
        break

      case 'output:result':
        agentStore.setResult({
          requestId: request_id || data.requestId || data.request_id || agentStore.activeRequestId,
          kind: data.kind || 'text',
          title: String(data.title || '任务结果'),
          content: String(data.content || ''),
          actions: Array.isArray(data.actions) ? data.actions.map(String) : [],
        } as AgentTaskResult)
        break

      case 'output:emoji':
        if (data.base64) chatStore.addEmojiMessage(data.base64, data.description || '')
        break

      case 'heartbeat':
        break

      default:
        console.log('[Deskpet] Unknown message type:', type, data)
    }
  }

  function send(type: string, data: Record<string, any> = {}) {
    if (ws.value?.readyState !== WebSocket.OPEN) return false
    ws.value.send(JSON.stringify({ type, data, timestamp: Date.now() }))
    return true
  }

  function sendScreenshot(base64: string, requestId: string) {
    return send('input:screenshot', { image: base64, requestId })
  }

  function startHeartbeat() {
    stopHeartbeat()
    heartbeatTimer.value = setInterval(() => {
      send('heartbeat')
    }, 15000)
  }

  function stopHeartbeat() {
    if (heartbeatTimer.value) {
      clearInterval(heartbeatTimer.value)
      heartbeatTimer.value = null
    }
  }

  function scheduleReconnect() {
    if (getAiProvider() !== 'maibot') return
    if (reconnectTimer.value) return
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt.value), maxReconnectDelay)
    reconnectAttempt.value++
    console.log(`[Deskpet] Reconnecting in ${delay}ms (attempt ${reconnectAttempt.value})`)
    reconnectTimer.value = setTimeout(() => {
      reconnectTimer.value = null
      connect()
    }, delay)
  }

  function disconnect() {
    stopOutput()
    stopHeartbeat()
    if (reconnectTimer.value) {
      clearTimeout(reconnectTimer.value)
      reconnectTimer.value = null
    }
    ws.value?.close()
    ws.value = null
  }

  onMounted(() => {
    if (getAiProvider() === 'maibot') connect()
  })

  onUnmounted(() => {
    disconnect()
  })

  return { ws, connect, disconnect, send, sendScreenshot, stopOutput }
}
