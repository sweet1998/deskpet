import { onUnmounted, ref, watch } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { useChatStore, type ChatReplyReference } from '@/stores/chat'
import type { DeskpetTransport } from '@/services/transport/types'
import { auditNativeTool } from '@/services/native-tool-runner'
import { useAttachmentWorkflow } from '@/composables/useAttachmentWorkflow'
import { useVoiceInput } from '@/composables/useVoiceInput'

const REQUEST_TIMEOUT_MS = 60_000

interface RequestWorkflowOptions {
  agent: ReturnType<typeof useAgentStore>
  chat: ReturnType<typeof useChatStore>
  transport: DeskpetTransport
  requireLegalConsent: () => boolean
  cancelSpeech: (markInterrupted?: boolean) => void
  isSpeaking: () => boolean
}

export function useAgentRequestWorkflow(options: RequestWorkflowOptions) {
  const { agent, chat, transport } = options
  const voiceInput = useVoiceInput()
  const pendingScreenshot = ref('')
  const requestTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const attachmentWorkflow = useAttachmentWorkflow({
    agent,
    chat,
    transport,
    requireLegalConsent: options.requireLegalConsent,
    cancelSpeech: options.cancelSpeech,
    createRequestId,
    followUpPrompt,
    startRequestTimer,
    clearRequestTimer,
  })

  function createRequestId(): string {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `deskpet-${Date.now()}-${Math.random().toString(16).slice(2)}`
  }

  function clearRequestTimer(requestId: string): void {
    const timer = requestTimers.get(requestId)
    if (timer) clearTimeout(timer)
    requestTimers.delete(requestId)
  }

  function startRequestTimer(requestId: string): void {
    clearRequestTimer(requestId)
    requestTimers.set(requestId, setTimeout(() => {
      requestTimers.delete(requestId)
      if (agent.activeRequestId !== requestId || !agent.interruptible) return
      transport.sendInterrupt(requestId)
      chat.finishThought(requestId)
      chat.showStatusMessage(requestId, '响应超时。请检查网络或 AI 服务配置后重试。', 'timeout')
      agent.applyState({
        requestId,
        state: 'error',
        progress: 0,
        step: '请求超时',
        interruptible: false,
        error: '响应超时，请稍后重试',
      })
    }, REQUEST_TIMEOUT_MS))
  }

  function followUpPrompt(text: string, replyTo?: ChatReplyReference): string {
    if (!replyTo) return text
    return `请基于本会话中这段回答继续回应。回答摘录：“${replyTo.preview}”\n用户追问：${text}`
  }

  function submitUserText(text: string, replyTo?: ChatReplyReference): void {
    const value = text.trim()
    if (!value || agent.interruptible || agent.confirmation || !options.requireLegalConsent()) return
    options.cancelSpeech()
    const requestId = createRequestId()
    chat.addUserMessage(value, requestId, agent.currentRole, [], replyTo)
    agent.beginRequest(requestId, value)
    agent.taskPanelOpen = false
    agent.applyState({ requestId, state: 'thinking', progress: 10, step: '正在理解你的请求', interruptible: true })
    agent.chatOpen = true
    startRequestTimer(requestId)
    if (!transport.sendUserText(followUpPrompt(value, replyTo), requestId)) {
      clearRequestTimer(requestId)
      chat.finishThought(requestId)
      chat.showStatusMessage(requestId, '尚未连接到 MaiBot，请检查连接设置后重试。', 'network')
      agent.applyState({ requestId, state: 'error', error: '尚未连接到 MaiBot' })
    }
  }

  function submitUserMessage(payload: { text: string; attachments: File[]; replyTo?: ChatReplyReference }): void {
    if (!payload.attachments.length) {
      submitUserText(payload.text, payload.replyTo)
      return
    }
    void attachmentWorkflow.submitUserFiles(payload.text, payload.attachments, payload.replyTo)
  }

  function analyzeScreenshot(base64: string): void {
    if (!base64 || agent.interruptible || agent.confirmation || !options.requireLegalConsent()) return
    options.cancelSpeech()
    const requestId = createRequestId()
    void auditNativeTool({
      requestId,
      roleId: agent.currentRole,
      tool: 'capture_screen',
      summary: '用户确认发送所选屏幕区域',
      status: 'succeeded',
    })
    chat.addUserMessage('分析当前屏幕', requestId, agent.currentRole, [], undefined, 'screenshot')
    agent.beginRequest(requestId, '分析当前屏幕', '屏幕截图')
    agent.taskPanelOpen = false
    agent.chatOpen = true
    agent.applyState({ requestId, state: 'executing', progress: 25, step: '正在理解屏幕内容', interruptible: true })
    startRequestTimer(requestId)
    if (!transport.sendScreenshot(base64, requestId)) {
      clearRequestTimer(requestId)
      chat.showStatusMessage(requestId, '截图分析提交失败，请检查 AI 配置。', 'service')
      agent.applyState({ requestId, state: 'error', error: '截图分析提交失败', interruptible: false })
    }
  }

  function previewScreenshot(base64: string): void {
    if (!base64 || agent.interruptible || agent.confirmation) return
    pendingScreenshot.value = base64
    agent.chatOpen = true
  }

  function confirmScreenshot(): void {
    const base64 = pendingScreenshot.value
    pendingScreenshot.value = ''
    analyzeScreenshot(base64)
  }

  async function captureCurrentScreen(): Promise<void> {
    if (agent.interruptible || agent.confirmation) return
    const base64 = await window.electronAPI?.captureScreenRegion()
    if (base64) previewScreenshot(base64)
  }

  function retryRequest(requestId: string): void {
    if (agent.interruptible || agent.confirmation) return
    const inputKind = chat.getRequestInputKind(requestId)
    if (inputKind === 'screenshot') {
      void captureCurrentScreen()
      return
    }
    if (inputKind === 'file') {
      attachmentWorkflow.retryFileRequest(requestId)
      return
    }
    const text = chat.getRequestText(requestId)
    if (!text || !options.requireLegalConsent()) return
    const roleId = chat.getRequestRole(requestId)
    if (roleId && roleId !== agent.currentRole) return
    options.cancelSpeech()
    chat.resetRequestResponse(requestId)
    agent.beginRequest(requestId, text)
    agent.taskPanelOpen = false
    agent.chatOpen = true
    agent.applyState({ requestId, state: 'thinking', progress: 10, step: '正在重新生成', interruptible: true })
    startRequestTimer(requestId)
    if (!transport.sendUserText(followUpPrompt(text, chat.getRequestReplyTo(requestId)), requestId)) {
      clearRequestTimer(requestId)
      chat.showStatusMessage(requestId, 'AI 服务当前不可用，请检查连接设置后重试。', 'network')
      agent.applyState({ requestId, state: 'error', error: 'AI 服务当前不可用', interruptible: false })
    }
  }

  async function startVoiceInput(): Promise<void> {
    if (agent.recording || !options.requireLegalConsent()) return
    const requestId = createRequestId()
    agent.beginRequest(requestId, '语音对话')
    agent.recording = true
    agent.applyState({ requestId, state: 'listening', step: '正在聆听', interruptible: true })
    try {
      await voiceInput.start()
    } catch {
      agent.recording = false
      agent.applyState({ requestId, state: 'error', error: '无法使用麦克风，请检查系统权限' })
    }
  }

  async function stopVoiceInput(): Promise<void> {
    if (!agent.recording) return
    agent.recording = false
    const result = await voiceInput.stop()
    if (result.text) {
      submitUserText(result.text)
      return
    }
    agent.applyState({
      requestId: agent.activeRequestId,
      state: 'error',
      progress: 0,
      step: '语音识别未完成',
      error: result.error || '没有识别到清晰语音，请重试。',
      interruptible: false,
    })
  }

  function interruptAgent(): void {
    if (options.isSpeaking()) {
      options.cancelSpeech(true)
      return
    }
    if (agent.recording) {
      agent.recording = false
      void voiceInput.stop()
    }
    const requestId = agent.activeRequestId
    transport.sendInterrupt(requestId)
    clearRequestTimer(requestId)
    chat.finishThought(requestId)
    agent.applyState({ requestId, state: 'interrupted', progress: 0, step: '已停止', interruptible: false })
  }

  function respondToConfirmation(allowed: boolean): void {
    const requestId = agent.confirmation?.requestId
    if (!requestId) return
    transport.sendConfirmation(requestId, allowed)
    agent.setConfirmation(null)
    agent.applyState({
      requestId,
      state: allowed ? 'executing' : 'interrupted',
      progress: agent.progress,
      step: allowed ? '已允许，继续执行' : '已取消操作',
      interruptible: allowed,
    })
  }

  async function saveTaskResult(): Promise<void> {
    const result = agent.taskResult
    if (!result) return
    const saved = await window.electronAPI?.saveAgentResult({ title: result.title, content: result.content })
    if (saved) agent.currentStep = '结果已保存'
  }

  watch(() => agent.activityVersion, () => {
    if (agent.activeRequestId && agent.interruptible) startRequestTimer(agent.activeRequestId)
  })

  watch(() => agent.state, (state) => {
    if (['success', 'error', 'interrupted', 'idle'].includes(state)) clearRequestTimer(agent.activeRequestId)
  })

  function cleanup(): void {
    for (const timer of requestTimers.values()) clearTimeout(timer)
    requestTimers.clear()
    attachmentWorkflow.clear()
  }

  onUnmounted(cleanup)

  return {
    pendingScreenshot,
    submitUserMessage,
    submitFiles: attachmentWorkflow.submitUserFiles,
    retryRequest,
    startVoiceInput,
    stopVoiceInput,
    interruptAgent,
    previewScreenshot,
    confirmScreenshot,
    captureCurrentScreen,
    respondToConfirmation,
    saveTaskResult,
    clearRequestTimer,
    cleanup,
  }
}
