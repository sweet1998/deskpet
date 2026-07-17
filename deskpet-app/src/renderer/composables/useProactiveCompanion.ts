import type { useAgentStore } from '@/stores/agent'

const LAST_GREETING_KEY = 'deskpet/last-proactive-greeting'
const LAST_BREAK_KEY = 'deskpet/last-break-reminder'
const BREAK_INTERVAL_MS = 90 * 60 * 1000

function minutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number)
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0)
}

function isQuietTime(start: string, end: string, now = new Date()): boolean {
  const current = now.getHours() * 60 + now.getMinutes()
  const from = minutes(start)
  const to = minutes(end)
  return from <= to ? current >= from && current < to : current >= from || current < to
}

export function useProactiveCompanion(agent: ReturnType<typeof useAgentStore>) {
  let greetingTimer: ReturnType<typeof setTimeout> | null = null
  let checkTimer: ReturnType<typeof setInterval> | null = null
  let dismissTimer: ReturnType<typeof setTimeout> | null = null
  const startedAt = Date.now()

  function showMessage(message: string) {
    agent.proactiveMessage = message
    if (dismissTimer) clearTimeout(dismissTimer)
    dismissTimer = setTimeout(() => {
      agent.proactiveMessage = ''
    }, 8000)
  }

  function maybeGreet() {
    if (!agent.proactiveEnabled || agent.workspaceOpen) return
    const now = new Date()
    if (isQuietTime(agent.quietStart, agent.quietEnd, now)) return
    const today = now.toISOString().slice(0, 10)
    if (localStorage.getItem(LAST_GREETING_KEY) === today) return

    const name = agent.userName ? `，${agent.userName}` : ''
    showMessage(`你好${name}。今天有什么想一起完成的吗？`)
    localStorage.setItem(LAST_GREETING_KEY, today)
  }

  function maybeSuggestBreak() {
    if (!agent.proactiveEnabled || agent.workspaceOpen || Date.now() - startedAt < BREAK_INTERVAL_MS) return
    if (isQuietTime(agent.quietStart, agent.quietEnd)) return
    const lastReminder = Number(localStorage.getItem(LAST_BREAK_KEY) || 0)
    if (Date.now() - lastReminder < BREAK_INTERVAL_MS) return
    showMessage('你已经专注很久了，要不要起来活动一下？')
    localStorage.setItem(LAST_BREAK_KEY, String(Date.now()))
  }

  function start() {
    greetingTimer = setTimeout(maybeGreet, 2500)
    checkTimer = setInterval(maybeSuggestBreak, 60_000)
  }

  function stop() {
    if (greetingTimer) clearTimeout(greetingTimer)
    if (checkTimer) clearInterval(checkTimer)
    if (dismissTimer) clearTimeout(dismissTimer)
    greetingTimer = null
    checkTimer = null
    dismissTimer = null
  }

  return { start, stop, maybeGreet, maybeSuggestBreak }
}
