import { useWebSocket } from '@/composables/useWebSocket'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { getAiProvider } from '@/services/ai-provider'
import type { DeskpetTransport } from './types'
import type { DoubaoMessage } from '../../../shared/doubao'

export function useChimeraTransport(): DeskpetTransport {
  const { connect, disconnect, send, sendScreenshot: wsSendScreenshot, stopOutput } = useWebSocket()
  const agent = useAgentStore()
  const chat = useChatStore()

  function buildDoubaoMessages(): DoubaoMessage[] {
    const identity = [
      '你是麦麦，一只生活在 macOS 桌面上的 Live2D AI 伙伴。',
      '回答自然、简洁、有温度，不要声称自己能执行尚未实际执行的工具。',
      agent.userName ? `用户希望被称为：${agent.userName}。` : '',
      agent.memories.length ? `你需要记住这些信息：${agent.memories.join('；')}` : '',
    ].filter(Boolean).join('\n')
    const history = chat.messages
      .filter((message) => message.type === 'text')
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.text }) as DoubaoMessage)
    return [{ role: 'system', content: identity }, ...history]
  }

  async function requestDoubao(requestId: string): Promise<void> {
    try {
      const result = await window.electronAPI?.doubaoChat({
        requestId,
        messages: buildDoubaoMessages(),
      })
      if (!result?.ok || !result.text) {
        agent.applyState({
          requestId,
          state: result?.error === '请求已取消' ? 'interrupted' : 'error',
          error: result?.error || '豆包请求失败',
        })
        return
      }
      agent.applyState({ requestId, state: 'speaking', progress: 90, step: '正在回答', interruptible: true })
      chat.appendChatText(result.text, requestId)
      chat.finishChatStream(requestId)
      agent.applyState({ requestId, state: 'success', progress: 100, step: '回答完成' })
      setTimeout(() => {
        chat.hideChatBubble()
        if (agent.activeRequestId === requestId) {
          agent.applyState({ requestId, state: 'idle', progress: 0, step: '' })
        }
      }, 8000)
    } catch (error) {
      agent.applyState({
        requestId,
        state: 'error',
        error: error instanceof Error ? error.message : '无法连接豆包服务',
      })
    }
  }

  function unsupportedDoubaoTask(requestId: string, task: string): boolean {
    agent.applyState({
      requestId,
      state: 'error',
      error: `${task}暂时需要切换到 MaiBot；豆包直连当前支持文字和语音对话。`,
    })
    return true
  }

  return {
    connect: () => { if (getAiProvider() === 'maibot') connect() },
    disconnect,
    sendHeartbeat: () => getAiProvider() === 'doubao' || send('heartbeat'),
    sendUserText: (text: string, requestId: string) => {
      if (getAiProvider() === 'maibot') return send('input:text', { text, requestId })
      void requestDoubao(requestId)
      return true
    },
    sendFile: (file) => getAiProvider() === 'maibot'
      ? send('input:file', file)
      : unsupportedDoubaoTask(file.requestId, '文件处理'),
    sendScreenshot: (base64: string, requestId: string) => getAiProvider() === 'maibot'
      ? wsSendScreenshot(base64, requestId)
      : unsupportedDoubaoTask(requestId, '截图理解'),
    sendInterrupt: (requestId: string) => {
      stopOutput()
      if (getAiProvider() === 'doubao') {
        void window.electronAPI?.cancelDoubaoChat(requestId)
        return true
      }
      return send('input:interrupt', { requestId })
    },
    sendConfirmation: (requestId: string, allowed: boolean) =>
      getAiProvider() === 'maibot' && send('tool:confirmation:response', { requestId, allowed }),
  }
}
