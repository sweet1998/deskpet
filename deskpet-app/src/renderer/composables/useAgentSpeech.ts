import { watch } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { createTtsBackend } from '@/services/tts/backend-composite'
import { useLipSync } from '@/composables/useLipSync'

export function useAgentSpeech(
  agent: ReturnType<typeof useAgentStore>,
  chat: ReturnType<typeof useChatStore>,
) {
  const ttsBackend = createTtsBackend()
  const lipSync = useLipSync()
  let speechGeneration = 0
  let speakingRequestId = ''
  let lastSpokenRequestId = ''

  function assistantReplyText(requestId: string): string {
    const message = chat.getRequestMessages(requestId).find((item) => (
      item.type === 'text' && item.role === 'assistant' && item.id === requestId
    ))
    return message?.type === 'text' ? message.text.trim() : ''
  }

  function cancel(markInterrupted = false): void {
    speechGeneration += 1
    const requestId = speakingRequestId
    speakingRequestId = ''
    ttsBackend.cancel()
    lipSync.stop()
    if (markInterrupted && requestId && agent.activeRequestId === requestId) {
      agent.applyState({
        requestId,
        state: 'interrupted',
        progress: 0,
        step: '已停止朗读',
        interruptible: false,
      })
    }
  }

  async function speakCompletedReply(requestId: string): Promise<void> {
    if (!requestId || requestId === lastSpokenRequestId || !agent.voiceReplyEnabled) return
    const text = assistantReplyText(requestId)
    if (!text) return

    cancel()
    lastSpokenRequestId = requestId
    speakingRequestId = requestId
    const generation = ++speechGeneration
    lipSync.start()
    agent.applyState({
      requestId,
      state: 'speaking',
      progress: 100,
      step: '正在朗读回答',
      interruptible: true,
    })
    await ttsBackend.speak(text)
    if (generation !== speechGeneration || speakingRequestId !== requestId) return

    speakingRequestId = ''
    lipSync.stop()
    if (agent.activeRequestId === requestId && agent.state === 'speaking') {
      agent.applyState({ requestId, state: 'success', progress: 100, step: '回答完成', interruptible: false })
      setTimeout(() => {
        if (agent.activeRequestId === requestId && agent.state === 'success') {
          agent.applyState({ requestId, state: 'idle', progress: 0, step: '', interruptible: false })
        }
      }, 1500)
    }
  }

  watch(
    [() => agent.state, () => agent.activeRequestId, () => agent.voiceReplyEnabled],
    ([state, requestId, enabled]) => {
      if (!enabled && speakingRequestId) {
        const completedRequestId = speakingRequestId
        cancel()
        if (agent.activeRequestId === completedRequestId && agent.state === 'speaking') {
          agent.applyState({
            requestId: completedRequestId,
            state: 'success',
            progress: 100,
            step: '回答完成',
            interruptible: false,
          })
        }
        return
      }
      if (enabled && state === 'success') void speakCompletedReply(requestId)
    },
  )

  return {
    cancel,
    cleanup: cancel,
    getMouthOpen: lipSync.getMouthOpen,
    isSpeaking: () => Boolean(speakingRequestId),
  }
}
