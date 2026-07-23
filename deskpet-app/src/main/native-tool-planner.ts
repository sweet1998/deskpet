import path from 'node:path'
import type { StoredDoubaoConfig } from './doubao-client'
import { requestDoubao } from './doubao-client'
import type {
  NativeReminder,
  NativeToolIntent,
  NativeToolPlanningResult,
} from '../shared/native-tools'

const MAX_OPERATIONS = 5
const MAX_REMINDER_AGE = 366 * 24 * 60 * 60 * 1000

interface PlannerInput {
  text: string
  now: number
  reminders: NativeReminder[]
}

function clean(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, limit) : ''
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  const normalized = value.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(normalized)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function reminderIntent(value: Record<string, unknown>, now: number): NativeToolIntent | null {
  const body = clean(value.body, 300)
  const title = clean(value.title, 80) || '麦麦提醒'
  const dueAt = typeof value.dueAt === 'number' ? value.dueAt : Date.parse(clean(value.dueAt, 80))
  if (!body || !Number.isFinite(dueAt) || dueAt < now + 3_000 || dueAt > now + MAX_REMINDER_AGE) return null
  return {
    kind: 'confirmation',
    name: 'create_reminder',
    summary: `在 ${new Date(dueAt).toLocaleString('zh-CN')} 提醒“${body}”`,
    pending: { name: 'create_reminder', reminder: { title, body, dueAt } },
  }
}

function normalizeOperation(
  value: unknown,
  now: number,
  reminders: NativeReminder[],
): NativeToolIntent | null {
  if (!value || typeof value !== 'object') return null
  const operation = value as Record<string, unknown>
  const name = clean(operation.name, 40)
  if (name === 'create_reminder') return reminderIntent(operation, now)
  if (name === 'list_reminders') {
    return { kind: 'immediate', name, summary: '查看提醒' }
  }
  if (name === 'cancel_reminder') {
    const reminderId = clean(operation.reminderId, 100)
    const reminder = reminders.find((item) => item.id === reminderId && item.status === 'scheduled')
    if (!reminder) return null
    return {
      kind: 'confirmation',
      name,
      summary: `取消提醒“${reminder.body}”`,
      pending: { name, reminderId, summary: reminder.body },
    }
  }
  if (name === 'write_clipboard') {
    const text = clean(operation.text, 20_000)
    if (!text) return null
    return {
      kind: 'confirmation',
      name,
      summary: `把“${text.slice(0, 80)}${text.length > 80 ? '…' : ''}”写入剪贴板`,
      pending: { name, text },
    }
  }
  if (name === 'open_url') {
    const raw = clean(operation.url, 2_000)
    try {
      const url = new URL(raw)
      if (!['http:', 'https:'].includes(url.protocol)) return null
      return {
        kind: 'confirmation',
        name,
        summary: `使用默认浏览器打开 ${url.toString()}`,
        pending: { name, url: url.toString() },
      }
    } catch {
      return null
    }
  }
  if (name === 'reveal_path') {
    const targetPath = clean(operation.path, 4_000)
    if (!targetPath || !path.isAbsolute(targetPath)) return null
    return {
      kind: 'confirmation',
      name,
      summary: `在 Finder 中显示 ${targetPath}`,
      pending: { name, path: targetPath },
    }
  }
  return null
}

export function normalizeNativeToolPlan(
  value: unknown,
  input: Pick<PlannerInput, 'now' | 'reminders'>,
): NativeToolIntent[] {
  if (!value || typeof value !== 'object') return []
  const operations = (value as { operations?: unknown }).operations
  if (!Array.isArray(operations) || operations.length > MAX_OPERATIONS) return []
  return operations
    .map((operation) => normalizeOperation(operation, input.now, input.reminders))
    .filter((intent): intent is NativeToolIntent => Boolean(intent))
}

export async function planNativeTools(
  config: StoredDoubaoConfig,
  input: PlannerInput,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<NativeToolPlanningResult> {
  const text = clean(input.text, 4_000)
  if (!text) return { intents: [] }
  const reminders = input.reminders
    .filter((item) => item.status === 'scheduled' && item.dueAt > input.now)
    .slice(0, 20)
    .map((item) => ({ id: item.id, body: item.body, dueAt: item.dueAt }))
  const system = [
    '你是 macOS 桌宠的本地工具规划器，只判断用户是否明确要求执行系统操作。',
    '只能输出 JSON，不要解释。格式：{"operations":[]}',
    '允许的 name：create_reminder、list_reminders、cancel_reminder、write_clipboard、open_url、reveal_path。',
    '创建提醒必须输出 title、body、dueAt（带时区 ISO 8601）；取消提醒只能使用提供的 reminderId。',
    '写剪贴板必须输出 text；打开网页必须输出 http/https url；Finder 定位必须输出绝对 path。',
    '用户只是咨询、讨论、要求读取剪贴板、意图不明确或参数不足时，operations 必须为空。最多 5 项，保持用户要求的顺序。',
  ].join('\n')
  const result = await requestDoubao(config, [
    { role: 'system', content: system },
    {
      role: 'user',
      content: JSON.stringify({
        currentLocalTime: new Date(input.now).toString(),
        scheduledReminders: reminders,
        request: text,
      }),
    },
  ], {
    maxTokens: 500,
    temperature: 0,
    jsonMode: true,
    signal: AbortSignal.timeout(12_000),
    fetchImpl: options.fetchImpl,
  })
  if (!result.ok || !result.text) return { intents: [], error: result.error || '工具规划失败' }
  const parsed = parseJsonObject(result.text)
  if (!parsed) return { intents: [], error: '工具规划结果格式无效' }
  return { intents: normalizeNativeToolPlan(parsed, input) }
}
