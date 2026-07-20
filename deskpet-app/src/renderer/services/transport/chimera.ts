import { useWebSocket } from '@/composables/useWebSocket'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { getAiProvider } from '@/services/ai-provider'
import type { DeskpetTransport } from './types'
import type { DoubaoMessage } from '../../../shared/doubao'
import { getRoleProfile, type RoleId } from '../../../shared/roles'
import type { MarketContextResult } from '../../../shared/market'
import { compactResearchContext, type ResearchPrepareResult } from '../../../shared/research'
import {
  getMarketSource,
  streamResearchPreparation,
  streamBackendChat,
  type BackendEvent,
} from '@/services/backend-client'
import { isAgentState } from '@/services/agent-protocol'

const REASONING_STEP_INTERVAL_MS = 220

export function useChimeraTransport(): DeskpetTransport {
  const { connect, disconnect, send, stopOutput } = useWebSocket()
  const agent = useAgentStore()
  const chat = useChatStore()
  const backendRequests = new Map<string, AbortController>()
  const lastReasoningAt = new Map<string, number>()

  async function presentReasoning(requestId: string, roleId: RoleId, text: string): Promise<void> {
    const normalized = text.trim()
    if (!normalized) return
    const wait = Math.max(
      0,
      (lastReasoningAt.get(requestId) || 0) + REASONING_STEP_INTERVAL_MS - Date.now(),
    )
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
    if (agent.currentRole !== roleId || chat.getRequestRole(requestId) !== roleId) return
    chat.appendThought(requestId, normalized)
    lastReasoningAt.set(requestId, Date.now())
  }

  function finishReasoning(requestId: string): void {
    lastReasoningAt.delete(requestId)
    chat.finishThought(requestId)
  }

  function showRequestError(
    requestId: string,
    roleId: RoleId,
    message: string,
    code: 'network' | 'service' = 'service',
  ): void {
    finishReasoning(requestId)
    chat.finishChatStream(requestId)
    chat.showStatusMessage(requestId, message, code)
    if (agent.currentRole === roleId) {
      agent.applyState({
        requestId,
        state: 'error',
        progress: 0,
        step: '请求失败',
        interruptible: false,
        error: message,
      })
    }
  }

  async function handleBackendEvent(event: BackendEvent, requestId: string, roleId: RoleId): Promise<void> {
    if (agent.currentRole !== roleId) return
    agent.touchRequest(requestId)
    const data = event.data
    if (event.event === 'state') {
      if (!isAgentState(data.state)) return
      agent.applyState({
        requestId,
        state: data.state,
        progress: data.progress,
        step: data.step,
        interruptible: Boolean(data.interruptible),
      })
    } else if (event.event === 'reasoning') {
      await presentReasoning(requestId, roleId, String(data.text || ''))
    } else if (event.event === 'delta' || event.event === 'result') {
      finishReasoning(requestId)
      chat.appendChatText(String(data.text || ''), requestId)
    } else if (event.event === 'done') {
      finishReasoning(requestId)
      chat.finishChatStream(requestId)
      agent.applyState({ requestId, state: 'success', progress: 100, step: '回答完成' })
    } else if (event.event === 'error') {
      showRequestError(requestId, roleId, String(data.message || '桌宠后端请求失败'))
    }
  }

  async function requestBackend(text: string, requestId: string, roleId: RoleId): Promise<void> {
    const controller = new AbortController()
    backendRequests.get(requestId)?.abort()
    backendRequests.set(requestId, controller)
    const history = chat.messagesByRole[roleId]
      .flatMap((message) => message.type === 'text' && message.id !== `user-${requestId}`
        ? [{ role: message.role, content: message.text }]
        : [])
      .slice(-20)
    try {
      await streamBackendChat({
        requestId,
        roleId,
        text,
        userName: agent.userName,
        memories: agent.memories,
        history,
      }, (event) => handleBackendEvent(event, requestId, roleId), controller.signal)
    } catch (error) {
      finishReasoning(requestId)
      if (agent.currentRole !== roleId) return
      if (error instanceof Error && error.name === 'AbortError') {
        if (agent.activeRequestId === requestId && !['error', 'interrupted'].includes(agent.state)) {
          agent.applyState({ requestId, state: 'interrupted', interruptible: false })
        }
      } else {
        showRequestError(
          requestId,
          roleId,
          error instanceof Error ? error.message : '无法连接桌宠后端',
          'network',
        )
      }
    } finally {
      if (backendRequests.get(requestId) === controller) backendRequests.delete(requestId)
    }
  }

  function researchInstruction(prepared: ResearchPrepareResult | undefined): string {
    if (!prepared) return ''
    const lines = [
      `本次问题意图：${prepared.intent}。`,
      '像熟悉市场的同事一样先直接回应用户最关心的点。短问题短答，不要复述问题，不要默认使用标题、编号或固定章节。',
      '不要用“综合来看”“基于以上分析”开场，也不要为了显得全面而补充用户没问的内容。',
    ]
    if (prepared.context) {
      lines.push('以下是精简后的研究事实。只使用与当前问题相关的数据；时效影响判断时再自然说明时间和来源，缺失项只有影响答案时才提，不得补造数据。')
      lines.push(JSON.stringify(compactResearchContext(prepared.context)))
    } else if (prepared.intent === 'education') {
      lines.push('这是股票知识问题，直接解释概念和必要边界，不要虚构实时行情。')
    }
    return lines.join('\n')
  }

  function buildDoubaoMessages(roleId: RoleId, prepared?: ResearchPrepareResult): DoubaoMessage[] {
    const profile = getRoleProfile(roleId)
    const identity = [
      profile.systemPrompt,
      `回答风格：${profile.responseStyle}`,
      agent.userName ? `用户希望被称为：${agent.userName}。` : '',
      agent.memories.length ? `你需要记住这些信息：${agent.memories.join('；')}` : '',
      roleId === 'stock_expert' ? researchInstruction(prepared) : '',
    ].filter(Boolean).join('\n')
    const history = chat.messagesByRole[roleId]
      .filter((message) => message.type === 'text')
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.text }) as DoubaoMessage)
    return [{ role: 'system', content: identity }, ...history]
  }

  async function requestDoubao(requestId: string, roleId: RoleId, prepared?: ResearchPrepareResult): Promise<void> {
    let receivedDelta = false
    const unsubscribe = window.electronAPI?.onDoubaoChatDelta(({ requestId: eventRequestId, delta }) => {
      if (eventRequestId !== requestId || !delta) return
      receivedDelta = true
      finishReasoning(requestId)
      chat.appendChatText(delta, requestId)
      if (agent.currentRole === roleId) {
        agent.touchRequest(requestId)
        agent.applyState({ requestId, state: 'speaking', progress: 90, step: '正在回答', interruptible: true })
      }
    })
    try {
      const result = await window.electronAPI?.doubaoChat({
        requestId,
        messages: buildDoubaoMessages(roleId, prepared),
      })
      if (!result?.ok || !result.text) {
        finishReasoning(requestId)
        if (result?.error === '请求已取消') {
          if (
            agent.currentRole === roleId
            && agent.activeRequestId === requestId
            && !['error', 'interrupted'].includes(agent.state)
          ) {
            agent.applyState({ requestId, state: 'interrupted', interruptible: false })
          }
        } else {
          showRequestError(requestId, roleId, result?.error || '豆包请求失败')
        }
        return
      }
      if (!receivedDelta && agent.currentRole === roleId) {
        agent.applyState({ requestId, state: 'speaking', progress: 90, step: '正在回答', interruptible: true })
      }
      finishReasoning(requestId)
      if (!receivedDelta) chat.appendChatText(result.text, requestId)
      chat.finishChatStream(requestId)
      if (agent.currentRole === roleId) {
        agent.applyState({ requestId, state: 'success', progress: 100, step: '回答完成' })
      }
      setTimeout(() => {
        chat.hideChatBubble()
        if (agent.activeRequestId === requestId) {
          agent.applyState({ requestId, state: 'idle', progress: 0, step: '' })
        }
      }, 8000)
    } catch (error) {
      showRequestError(
        requestId,
        roleId,
        error instanceof Error ? error.message : '无法连接豆包服务',
        'network',
      )
    } finally {
      unsubscribe?.()
    }
  }

  function roleHistory(roleId: RoleId, requestId: string) {
    return chat.messagesByRole[roleId]
      .filter((message) => message.type === 'text' && message.id !== `user-${requestId}`)
      .slice(-6)
      .map((message) => ({ role: message.role, content: message.text }))
  }

  function completeLocalReply(requestId: string, roleId: RoleId, text: string): void {
    finishReasoning(requestId)
    chat.appendChatText(text, requestId)
    chat.finishChatStream(requestId)
    if (agent.currentRole === roleId) {
      agent.applyState({ requestId, state: 'success', progress: 100, step: '回答完成', interruptible: false })
    }
  }

  async function sendRoleText(text: string, requestId: string, roleId: RoleId): Promise<void> {
    if (getAiProvider() === 'backend') {
      await requestBackend(text, requestId, roleId)
      return
    }
    let prepared: ResearchPrepareResult | undefined
    if (roleId === 'stock_expert') {
      try {
        prepared = await streamResearchPreparation({
          text,
          roleId,
          history: roleHistory(roleId, requestId),
        }, async (thought) => {
          if (agent.currentRole !== roleId || chat.getRequestRole(requestId) !== roleId) return
          await presentReasoning(requestId, roleId, thought)
          agent.touchRequest(requestId)
          agent.applyState({
            requestId,
            state: 'executing',
            progress: 45,
            step: '正在获取并计算研究数据',
            interruptible: true,
          })
        })
      } catch (error) {
        showRequestError(
          requestId,
          roleId,
          error instanceof Error ? error.message : '无法连接研究准备服务',
          'network',
        )
        return
      }
      if (prepared.scope !== 'in_scope') {
        completeLocalReply(requestId, roleId, prepared.reply || '请补充更明确的 A 股研究问题。')
        return
      }
      if (getMarketSource() === 'opend' && prepared.targetKind === 'security') {
        const openDContext: MarketContextResult | undefined = await window.electronAPI?.getMarketContext(text)
        if (openDContext?.status === 'ok') {
          prepared = {
            ...prepared,
            context: compactResearchContext({ kind: 'security', market: openDContext }),
          }
        }
      }
    }
    if (agent.currentRole !== roleId || chat.getRequestRole(requestId) !== roleId) return
    if (getAiProvider() === 'maibot') {
      const sent = send('input:text', { text, requestId, roleId, research: prepared })
      if (!sent && agent.currentRole === roleId) {
        showRequestError(requestId, roleId, '尚未连接到 MaiBot，请检查连接设置后重试。', 'network')
      }
      return
    }
    await requestDoubao(requestId, roleId, prepared)
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
    sendHeartbeat: () => getAiProvider() !== 'maibot' || send('heartbeat'),
    sendUserText: (text: string, requestId: string) => {
      const roleId = agent.currentRole
      chat.bindRequest(requestId, roleId)
      void sendRoleText(text, requestId, roleId)
      return true
    },
    sendFile: (file) => getAiProvider() === 'maibot'
      ? send('input:file', { ...file, roleId: agent.currentRole })
      : unsupportedDoubaoTask(file.requestId, '文件处理'),
    sendScreenshot: (base64: string, requestId: string) => getAiProvider() === 'maibot'
      ? send('input:screenshot', { image: base64, requestId, roleId: agent.currentRole })
      : unsupportedDoubaoTask(requestId, '截图理解'),
    sendInterrupt: (requestId: string) => {
      stopOutput()
      if (getAiProvider() === 'backend') {
        const controller = backendRequests.get(requestId)
        controller?.abort()
        return Boolean(controller)
      }
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
