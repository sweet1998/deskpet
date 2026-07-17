import { useWebSocket } from '@/composables/useWebSocket'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { getAiProvider } from '@/services/ai-provider'
import type { DeskpetTransport } from './types'
import type { DoubaoMessage } from '../../../shared/doubao'
import { getRoleProfile, type RoleId } from '../../../shared/roles'
import type { MarketContextResult } from '../../../shared/market'

export function useChimeraTransport(): DeskpetTransport {
  const { connect, disconnect, send, stopOutput } = useWebSocket()
  const agent = useAgentStore()
  const chat = useChatStore()

  function marketInstruction(context: MarketContextResult | undefined): string {
    if (!context || context.status === 'no-symbol') return ''
    if (context.status !== 'ok') {
      return `实时行情不可用：${context.error || '未获得有效行情'}。必须明确告知用户无法验证当前价格，不得猜测或编造实时数据。`
    }
    return [
      `以下是来自 ${context.source} 的结构化只读行情，采集时间 ${context.asOf || '未知'}，市场状态 ${context.marketStatus || '未知'}。`,
      '仅把这些字段视为行情事实；stale=true 时必须提示数据陈旧；休市时必须说明已休市及最近更新时间。',
      JSON.stringify(context),
    ].join('\n')
  }

  function buildDoubaoMessages(roleId: RoleId, marketContext?: MarketContextResult): DoubaoMessage[] {
    const profile = getRoleProfile(roleId)
    const identity = [
      profile.systemPrompt,
      `回答风格：${profile.responseStyle}`,
      agent.userName ? `用户希望被称为：${agent.userName}。` : '',
      agent.memories.length ? `你需要记住这些信息：${agent.memories.join('；')}` : '',
      roleId === 'stock_expert' ? marketInstruction(marketContext) : '',
    ].filter(Boolean).join('\n')
    const history = chat.messagesByRole[roleId]
      .filter((message) => message.type === 'text')
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.text }) as DoubaoMessage)
    return [{ role: 'system', content: identity }, ...history]
  }

  async function requestDoubao(requestId: string, roleId: RoleId, marketContext?: MarketContextResult): Promise<void> {
    try {
      const result = await window.electronAPI?.doubaoChat({
        requestId,
        messages: buildDoubaoMessages(roleId, marketContext),
      })
      if (!result?.ok || !result.text) {
        if (agent.currentRole === roleId) agent.applyState({
          requestId,
          state: result?.error === '请求已取消' ? 'interrupted' : 'error',
          error: result?.error || '豆包请求失败',
        })
        return
      }
      if (agent.currentRole === roleId) {
        agent.applyState({ requestId, state: 'speaking', progress: 90, step: '正在回答', interruptible: true })
      }
      chat.appendChatText(result.text, requestId)
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
      if (agent.currentRole === roleId) agent.applyState({
        requestId,
        state: 'error',
        error: error instanceof Error ? error.message : '无法连接豆包服务',
      })
    }
  }

  function ambiguousReply(context: MarketContextResult): string {
    const choices = (context.candidates || [])
      .map((item) => `${item.name}（${item.code}）`)
      .join('、')
    return `找到多个可能的股票：${choices || '名称不明确'}。请回复六位股票代码确认。`
  }

  async function sendRoleText(text: string, requestId: string, roleId: RoleId): Promise<void> {
    const marketContext = roleId === 'stock_expert'
      ? await window.electronAPI?.getMarketContext(text)
      : undefined
    if (agent.currentRole !== roleId || chat.getRequestRole(requestId) !== roleId) return
    if (marketContext?.status === 'ambiguous') {
      chat.appendChatText(ambiguousReply(marketContext), requestId)
      chat.finishChatStream(requestId)
      if (agent.currentRole === roleId) {
        agent.applyState({ requestId, state: 'success', progress: 100, step: '等待确认股票代码' })
      }
      return
    }
    if (getAiProvider() === 'maibot') {
      const sent = send('input:text', { text, requestId, roleId, marketContext })
      if (!sent && agent.currentRole === roleId) {
        agent.applyState({ requestId, state: 'error', error: '尚未连接到 MaiBot' })
      }
      return
    }
    await requestDoubao(requestId, roleId, marketContext)
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
