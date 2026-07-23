import type { useAgentStore } from '@/stores/agent'

const LAST_GREETING_KEY = 'deskpet/last-proactive-greeting'
const LAST_BREAK_KEY = 'deskpet/last-break-reminder'
const BREAK_INTERVAL_MS = 90 * 60 * 1000
const IDLE_RESET_SECONDS = 10 * 60
const RECENT_ACTIVITY_SECONDS = 2 * 60

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

function localDateKey(now: Date): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

export function nextActiveFocusDuration(
  current: number,
  elapsed: number,
  idleSeconds: number,
): number {
  if (!Number.isFinite(idleSeconds) || idleSeconds >= IDLE_RESET_SECONDS) return 0
  if (idleSeconds > RECENT_ACTIVITY_SECONDS) return current
  return current + Math.max(0, Math.min(elapsed, 2 * 60 * 1000))
}

export function useProactiveCompanion(agent: ReturnType<typeof useAgentStore>) {
  let greetingTimer: ReturnType<typeof setTimeout> | null = null
  let checkTimer: ReturnType<typeof setInterval> | null = null
  let dismissTimer: ReturnType<typeof setTimeout> | null = null
  let activeFocusDuration = 0
  let lastCheckAt = Date.now()

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
    const today = localDateKey(now)
    if (localStorage.getItem(LAST_GREETING_KEY) === today) return

    const name = agent.userName ? `，${agent.userName}` : ''
    const remembered = agent.memories.find((item) => item.trim())?.trim().slice(0, 60)
    showMessage(remembered
      ? `你好${name}。你之前让我记住“${remembered}”，今天要一起处理吗？`
      : `你好${name}。今天有什么想一起完成的吗？`)
    localStorage.setItem(LAST_GREETING_KEY, today)
  }

  async function maybeSuggestBreak() {
    const now = Date.now()
    const elapsed = Math.max(0, now - lastCheckAt)
    lastCheckAt = now
    if (!agent.proactiveEnabled || agent.workspaceOpen) return
    if (isQuietTime(agent.quietStart, agent.quietEnd)) return
    const idleSeconds = await window.electronAPI?.getSystemIdleTime() ?? IDLE_RESET_SECONDS
    activeFocusDuration = nextActiveFocusDuration(activeFocusDuration, elapsed, idleSeconds)
    if (activeFocusDuration < BREAK_INTERVAL_MS) return
    const lastReminder = Number(localStorage.getItem(LAST_BREAK_KEY) || 0)
    if (now - lastReminder < BREAK_INTERVAL_MS) return
    showMessage('你已经专注很久了，要不要起来活动一下？')
    localStorage.setItem(LAST_BREAK_KEY, String(now))
    activeFocusDuration = 0
  }

  function start() {
    activeFocusDuration = 0
    lastCheckAt = Date.now()
    greetingTimer = setTimeout(maybeGreet, 2500)
    checkTimer = setInterval(() => { void maybeSuggestBreak() }, 60_000)
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
