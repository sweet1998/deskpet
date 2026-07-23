import type { NativeReminderInput, NativeToolIntent } from '../../shared/native-tools'

function normalizedBody(text: string, fragments: string[]): string {
  let body = text
  for (const fragment of fragments) body = body.replace(fragment, ' ')
  return body
    .replace(/^(请|麻烦|帮我|可以)?\s*(提醒我|设置提醒|创建提醒)\s*/i, '')
    .replace(/[，,。.!！]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function reminder(title: string, body: string, dueAt: number, now: Date): NativeReminderInput | null {
  if (!body || !Number.isFinite(dueAt) || dueAt <= now.getTime()) return null
  return { title, body: body.slice(0, 300), dueAt }
}

function applyClock(date: Date, period: string | undefined, rawHour: string, rawMinute?: string): boolean {
  let hour = Number(rawHour)
  const minute = Number(rawMinute || 0)
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return false
  if ((period === '下午' || period === '晚上') && hour < 12) hour += 12
  if (period === '中午' && hour < 11) hour += 12
  if ((period === '上午' || period === '早上') && hour === 12) hour = 0
  date.setHours(hour, minute, 0, 0)
  return true
}

export function parseReminder(text: string, now = new Date()): NativeReminderInput | null {
  if (!text.includes('提醒')) return null
  const source = text
    .replace(/今晚/g, '今天晚上')
    .replace(/今早/g, '今天早上')
    .replace(/明晚/g, '明天晚上')
    .replace(/明早/g, '明天早上')

  if (/半\s*(?:个)?小时后/.test(source)) {
    const fragment = source.match(/半\s*(?:个)?小时后/)?.[0] || '半小时后'
    const body = normalizedBody(source, [fragment])
    return reminder('麦麦提醒', body, now.getTime() + 30 * 60_000, now)
  }

  const relative = source.match(/(\d{1,4})\s*(分钟|小时|天)后/)
  if (relative) {
    const amount = Number(relative[1])
    const unitMs = relative[2] === '分钟' ? 60_000 : relative[2] === '小时' ? 3_600_000 : 86_400_000
    const body = normalizedBody(source, [relative[0]])
    return reminder('麦麦提醒', body, now.getTime() + amount * unitMs, now)
  }

  const dayTime = source.match(/(今天|明天|后天)\s*(上午|下午|晚上|中午|早上)?\s*(\d{1,2})(?:[点:：时]\s*(\d{1,2})?分?)?/)
  if (dayTime) {
    const due = new Date(now)
    due.setDate(due.getDate() + ({ 今天: 0, 明天: 1, 后天: 2 }[dayTime[1]] ?? 0))
    if (!applyClock(due, dayTime[2], dayTime[3], dayTime[4])) return null
    const body = normalizedBody(source, [dayTime[0]])
    return reminder('麦麦提醒', body, due.getTime(), now)
  }

  const weekday = source.match(/((?:本|这|下)?(?:周|星期))([一二三四五六日天])\s*(上午|下午|晚上|中午|早上)?\s*(\d{1,2})(?:[点:：时]\s*(\d{1,2})?分?)?/)
  if (weekday) {
    const targetDay = ({ 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 } as Record<string, number>)[weekday[2]]
    if (targetDay == null) return null
    const currentDay = (now.getDay() + 6) % 7
    const due = new Date(now)
    const nextWeek = weekday[1].startsWith('下')
    due.setDate(now.getDate() - currentDay + targetDay + (nextWeek ? 7 : 0))
    if (!applyClock(due, weekday[3], weekday[4], weekday[5])) return null
    if (!nextWeek && due.getTime() <= now.getTime()) due.setDate(due.getDate() + 7)
    const body = normalizedBody(source, [weekday[0]])
    return reminder('麦麦提醒', body, due.getTime(), now)
  }

  const calendar = source.match(/(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})[日\s]*\s*(\d{1,2})(?:[点:：时]\s*(\d{1,2})?分?)?/)
  if (calendar) {
    const year = Number(calendar[1] || now.getFullYear())
    const due = new Date(year, Number(calendar[2]) - 1, Number(calendar[3]), Number(calendar[4]), Number(calendar[5] || 0), 0, 0)
    if (due.getFullYear() !== year || due.getMonth() !== Number(calendar[2]) - 1 || due.getDate() !== Number(calendar[3])) return null
    const body = normalizedBody(source, [calendar[0]])
    return reminder('麦麦提醒', body, due.getTime(), now)
  }

  const clock = source.match(/(上午|下午|晚上|中午|早上)?\s*(\d{1,2})(?:[点:：时]\s*(\d{1,2})?分?)/)
  if (clock) {
    const due = new Date(now)
    if (!applyClock(due, clock[1], clock[2], clock[3])) return null
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1)
    const body = normalizedBody(source, [clock[0]])
    return reminder('麦麦提醒', body, due.getTime(), now)
  }

  return null
}

export function parseNativeToolIntents(text: string, now = new Date()): NativeToolIntent[] {
  const segments = text
    .split(/(?:[；;]\s*|[，,]?\s*(?:然后|接着|随后|并且|再)\s*)/)
    .map((item) => item.trim())
    .filter(Boolean)
  if (segments.length > 1) {
    const intents = segments
      .map((segment) => parseNativeToolIntent(segment, now))
      .filter((intent): intent is NativeToolIntent => Boolean(intent))
    if (intents.length === segments.length) return intents
  }
  const intent = parseNativeToolIntent(text, now)
  return intent ? [intent] : []
}

export function shouldPlanNativeTools(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  return /提醒|闹钟|别让我忘|记得(?:叫|喊|通知)我|(?:半|\d+)(?:个)?(?:分钟|小时|天)后.{0,12}(?:叫|喊|通知)我|剪贴板|(?:打开|访问|浏览).{0,20}(?:网页|网址|链接|https?:\/\/)|(?:访达|Finder).{0,16}(?:显示|打开|定位)|(?:显示|定位).{0,16}(?:文件|目录|文件夹)/i.test(normalized)
}

export function parseNativeToolIntent(text: string, now = new Date()): NativeToolIntent | null {
  const normalized = text.trim()
  if (!normalized) return null

  if (/提醒(列表|事项)|(?:查看|列出|看看|有哪些).{0,4}提醒/.test(normalized)) {
    return { kind: 'immediate', name: 'list_reminders', summary: '查看提醒' }
  }

  const reminderInput = parseReminder(normalized, now)
  if (reminderInput) {
    return {
      kind: 'confirmation',
      name: 'create_reminder',
      summary: `在 ${new Date(reminderInput.dueAt).toLocaleString('zh-CN')} 提醒“${reminderInput.body}”`,
      pending: { name: 'create_reminder', reminder: reminderInput },
    }
  }

  const clipboardWrite = normalized.match(/(?:把|将)\s*(.+?)\s*(?:复制|写入|放)(?:到|进)\s*剪贴板/)
    ?? normalized.match(/复制[：:\s]+(.+?)(?:到剪贴板)?$/)
  if (clipboardWrite?.[1]?.trim()) {
    const value = clipboardWrite[1].trim().slice(0, 20_000)
    return {
      kind: 'confirmation',
      name: 'write_clipboard',
      summary: `把“${value.slice(0, 80)}${value.length > 80 ? '…' : ''}”写入剪贴板`,
      pending: { name: 'write_clipboard', text: value },
    }
  }

  const url = normalized.match(/https?:\/\/[^\s，。]+/i)?.[0]
  if (url && /打开|访问|浏览/.test(normalized)) {
    return {
      kind: 'confirmation',
      name: 'open_url',
      summary: `使用默认浏览器打开 ${url}`,
      pending: { name: 'open_url', url },
    }
  }

  const targetPath = normalized.match(/(?:访达|Finder).{0,8}(\/[^\n]+)$/i)?.[1]?.trim()
  if (targetPath && /显示|打开|定位/.test(normalized)) {
    return {
      kind: 'confirmation',
      name: 'reveal_path',
      summary: `在 Finder 中显示 ${targetPath}`,
      pending: { name: 'reveal_path', path: targetPath },
    }
  }

  return null
}
