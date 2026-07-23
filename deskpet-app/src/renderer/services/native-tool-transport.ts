import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { parseMemoryIntent } from '@/services/memory-intent'
import { parseNativeToolIntents, shouldPlanNativeTools } from '@/services/native-intent'
import {
  auditNativeTool,
  createNativeToolPlan,
  executeNativeTool as runNativeTool,
  nativeConfirmationExpired,
  type NativeToolOperation,
} from '@/services/native-tool-runner'
import { getRoleProfile, roleCanUseNativeTool, type RoleId } from '../../shared/roles'
import type { NativeReminder, NativeToolPlan } from '../../shared/native-tools'

type AgentStore = ReturnType<typeof useAgentStore>
type ChatStore = ReturnType<typeof useChatStore>

interface NativeToolTransportOptions {
  agent: AgentStore
  chat: ChatStore
  finishReasoning: (requestId: string) => void
  completeLocalReply: (requestId: string, roleId: RoleId, text: string) => void
  showRequestError: (requestId: string, roleId: RoleId, message: string) => void
}

interface PendingNativeTools {
  roleId: RoleId
  operations: NativeToolOperation[]
  plan: NativeToolPlan
  stepIndex: number
  results: string[]
  expiresAt: number
}

export function createNativeToolTransport(options: NativeToolTransportOptions) {
  const { agent, chat, finishReasoning, completeLocalReply, showRequestError } = options
  const pendingTools = new Map<string, PendingNativeTools>()

  function activeReminders(reminders: NativeReminder[]): NativeReminder[] {
    return reminders
      .filter((reminder) => reminder.status === 'scheduled' && reminder.dueAt > Date.now())
      .sort((a, b) => a.dueAt - b.dueAt)
  }

  function formatReminderTime(dueAt: number): string {
    return new Date(dueAt).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  }

  function presentConfirmation(requestId: string, pending: PendingNativeTools): void {
    const step = pending.plan.steps[pending.stepIndex]
    const expiresAt = Date.now() + 5 * 60_000
    pending.expiresAt = expiresAt
    void auditNativeTool({
      requestId, roleId: pending.roleId, tool: step.tool, summary: step.summary, status: 'requested',
    })
    void auditNativeTool({
      requestId, roleId: pending.roleId, tool: step.tool, summary: step.summary, status: 'awaiting_confirmation',
    })
    agent.setConfirmation({
      requestId,
      tool: step.tool,
      summary: step.summary,
      risk: step.risk,
      expiresAt,
    })
    agent.applyState({
      requestId,
      state: 'awaiting_confirmation',
      progress: Math.round(35 + (pending.stepIndex / pending.operations.length) * 45),
      step: `等待确认（${pending.stepIndex + 1}/${pending.operations.length}）`,
      interruptible: false,
    })
  }

  function requestConfirmations(
    requestId: string,
    roleId: RoleId,
    operations: NativeToolOperation[],
  ): void {
    const goal = chat.getRequestText(requestId) || operations[0]?.summary || '执行系统操作'
    const plan = createNativeToolPlan(requestId, roleId, goal, operations)
    const pending = { roleId, operations, plan, stepIndex: 0, results: [], expiresAt: 0 }
    pendingTools.set(requestId, pending)
    finishReasoning(requestId)
    presentConfirmation(requestId, pending)
  }

  function handleMemoryIntent(text: string, requestId: string, roleId: RoleId): boolean {
    if (roleId !== 'default') return false
    const intent = parseMemoryIntent(chat.getRequestText(requestId) || text)
    if (!intent) return false
    if (intent.kind === 'remember') {
      const saved = agent.addMemory(intent.value)
      completeLocalReply(
        requestId,
        roleId,
        saved ? `记住了：${intent.value}` : '这条内容已经记住了，或者记忆数量已达到上限。',
      )
      return true
    }
    if (intent.kind === 'set_name') {
      agent.userName = intent.value
      completeLocalReply(requestId, roleId, `好，以后我叫你${intent.value}。`)
      return true
    }
    if (intent.kind === 'list') {
      completeLocalReply(
        requestId,
        roleId,
        agent.memories.length
          ? ['我记得这些：', ...agent.memories.map((item, index) => `${index + 1}. ${item}`)].join('\n')
          : '目前还没有保存长期记忆。',
      )
      return true
    }
    if (intent.kind === 'forget_all') {
      agent.clearMemories()
      completeLocalReply(requestId, roleId, '长期记忆已经全部清除。')
      return true
    }
    const query = intent.value.replace(/[，,。.!！\s]/g, '')
    const indexes = agent.memories.flatMap((memory, index) => (
      memory.replace(/[，,。.!！\s]/g, '').includes(query) ? [index] : []
    ))
    for (const index of indexes.reverse()) agent.removeMemory(index)
    completeLocalReply(
      requestId,
      roleId,
      indexes.length ? `已经忘掉与“${intent.value}”有关的记忆。` : `没有找到与“${intent.value}”匹配的记忆。`,
    )
    return true
  }

  async function handleNativeIntent(text: string, requestId: string, roleId: RoleId): Promise<boolean> {
    const originalText = chat.getRequestText(requestId) || text
    if (/取消.{0,8}提醒|提醒.{0,8}取消/.test(originalText)) {
      if (!roleCanUseNativeTool(roleId, 'cancel_reminder')) {
        completeLocalReply(requestId, roleId, getRoleProfile(roleId).outOfScopeMessage)
        return true
      }
      const reminders = activeReminders(await window.electronAPI?.listNativeReminders() ?? [])
      if (!reminders.length) {
        completeLocalReply(requestId, roleId, '目前没有待触发的提醒。')
        return true
      }
      const query = originalText
        .replace(/取消|提醒|一下|帮我|请/g, '')
        .replace(/[，,。.!！\s]/g, '')
      const target = reminders.find((item) => !query || item.body.replace(/\s/g, '').includes(query)) ?? reminders[0]
      requestConfirmations(requestId, roleId, [{
        tool: { name: 'cancel_reminder', reminderId: target.id, summary: target.body },
        summary: `取消 ${formatReminderTime(target.dueAt)} 的提醒“${target.body}”`,
      }])
      return true
    }

    let intents = parseNativeToolIntents(originalText)
    if (!intents.length && roleId === 'default' && shouldPlanNativeTools(originalText)) {
      agent.applyState({
        requestId,
        state: 'thinking',
        progress: 20,
        step: '正在理解系统操作',
        interruptible: true,
      })
      try {
        const planned = await window.electronAPI?.planNativeTools({ text: originalText })
        intents = planned?.intents ?? []
      } catch {
        intents = []
      }
    }
    if (!intents.length) return false
    if (intents.some((intent) => !roleCanUseNativeTool(roleId, intent.name))) {
      completeLocalReply(requestId, roleId, getRoleProfile(roleId).outOfScopeMessage)
      return true
    }
    const immediateReplies: string[] = []
    for (const intent of intents.filter((item) => item.name === 'list_reminders')) {
      const reminders = activeReminders(await window.electronAPI?.listNativeReminders() ?? [])
      const reply = reminders.length
        ? ['待触发的提醒：', ...reminders.map((item, index) => (
            `${index + 1}. ${formatReminderTime(item.dueAt)}  ${item.body}`
          ))].join('\n')
        : '目前没有待触发的提醒。'
      immediateReplies.push(reply)
      void auditNativeTool({
        requestId, roleId, tool: 'list_reminders', summary: '查看待触发提醒', status: 'succeeded',
      })
    }
    const operations = intents.flatMap((intent): NativeToolOperation[] => (
      intent.kind === 'confirmation' && intent.pending
        ? [{ tool: intent.pending, summary: intent.summary }]
        : []
    ))
    if (operations.length) {
      if (immediateReplies.length) chat.appendChatText(`${immediateReplies.join('\n\n')}\n\n`, requestId)
      requestConfirmations(requestId, roleId, operations)
      return true
    }
    if (immediateReplies.length) {
      completeLocalReply(requestId, roleId, immediateReplies.join('\n\n'))
      return true
    }
    return false
  }

  async function handleIntent(text: string, requestId: string, roleId: RoleId): Promise<boolean> {
    if (handleMemoryIntent(text, requestId, roleId)) return true
    return handleNativeIntent(text, requestId, roleId)
  }

  async function resolveConfirmation(requestId: string, allowed: boolean): Promise<void> {
    const pending = pendingTools.get(requestId)
    if (!pending) return
    const operation = pending.operations[pending.stepIndex]
    const step = pending.plan.steps[pending.stepIndex]
    if (!allowed) {
      pendingTools.delete(requestId)
      void auditNativeTool({
        requestId, roleId: pending.roleId, tool: step.tool, summary: step.summary, status: 'denied',
      })
      chat.appendChatText('已取消这次操作。', requestId)
      chat.finishChatStream(requestId)
      if (agent.currentRole === pending.roleId) {
        agent.applyState({ requestId, state: 'interrupted', progress: 0, step: '已取消', interruptible: false })
        agent.taskPanelOpen = false
      }
      return
    }
    if (nativeConfirmationExpired(pending.expiresAt)) {
      pendingTools.delete(requestId)
      await auditNativeTool({
        requestId,
        roleId: pending.roleId,
        tool: step.tool,
        summary: step.summary,
        status: 'failed',
        error: '用户确认已过期',
      })
      chat.appendChatText('这次操作确认已过期，请重新发起。', requestId)
      chat.finishChatStream(requestId)
      if (agent.currentRole === pending.roleId) {
        agent.applyState({
          requestId,
          state: 'interrupted',
          progress: 0,
          step: '确认已过期',
          interruptible: false,
        })
        agent.taskPanelOpen = false
      }
      return
    }
    try {
      agent.applyState({
        requestId,
        state: 'executing',
        progress: Math.round(55 + (pending.stepIndex / pending.operations.length) * 35),
        step: `正在执行（${pending.stepIndex + 1}/${pending.operations.length}）`,
        interruptible: false,
      })
      const reply = await runNativeTool(operation.tool)
      await auditNativeTool({
        requestId, roleId: pending.roleId, tool: step.tool, summary: step.summary, status: 'succeeded',
      })
      pending.results.push(reply)
      pending.stepIndex += 1
      if (pending.stepIndex < pending.operations.length) {
        presentConfirmation(requestId, pending)
        return
      }
      pendingTools.delete(requestId)
      completeLocalReply(requestId, pending.roleId, pending.results.join('\n'))
      if (agent.currentRole === pending.roleId) agent.taskPanelOpen = false
    } catch (error) {
      pendingTools.delete(requestId)
      await auditNativeTool({
        requestId,
        roleId: pending.roleId,
        tool: step.tool,
        summary: step.summary,
        status: 'failed',
        error: error instanceof Error ? error.message : '系统工具执行失败',
      })
      showRequestError(
        requestId,
        pending.roleId,
        error instanceof Error ? error.message : '系统工具执行失败',
      )
      if (agent.currentRole === pending.roleId) agent.taskPanelOpen = false
    }
  }

  return {
    handleIntent,
    resolveConfirmation,
    hasPending: (requestId: string) => pendingTools.has(requestId),
  }
}
