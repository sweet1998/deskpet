const MAX_MENU_ITEMS = 32
const MAX_RAW_MENU_ITEMS = 128
const MAX_RAW_ID_LENGTH = 256
const MENU_ID = /^[A-Za-z0-9:_-]{1,64}$/

export interface PetContextMenuRequest {
  emotions: string[]
  actions: string[]
}

export type PetContextMenuCommand =
  | { type: 'settings' }
  | { type: 'emotion'; id: string }
  | { type: 'action'; id: string }

const EMOTION_LABELS: Record<string, string> = {
  happy: '开心',
  sad: '难过',
  angry: '生气',
  surprise: '惊讶',
  thinking: '思考',
  shy: '害羞',
  curious: '好奇',
  neutral: '默认',
  idle: '放松',
}

const ACTION_LABELS: Record<string, string> = {
  wave: '挥手',
  walk: '走路',
  crawl: '爬行',
  jump: '跳跃',
  roll: '打滚',
  spin: '旋转',
  sit: '坐下',
  sleep: '睡觉',
  wake: '醒来',
  dance: '跳舞',
  cheer: '欢呼',
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const result: string[] = []
  const seen = new Set<string>()

  const scanLimit = Math.min(value.length, MAX_RAW_MENU_ITEMS)
  for (let index = 0; index < scanLimit; index += 1) {
    const entry = value[index]
    if (typeof entry !== 'string' || entry.length > MAX_RAW_ID_LENGTH) continue

    const id = entry.trim()
    if (!MENU_ID.test(id) || seen.has(id)) continue

    seen.add(id)
    result.push(id)
    if (result.length === MAX_MENU_ITEMS) break
  }

  return result
}

export function normalizePetContextMenuRequest(value: unknown): PetContextMenuRequest {
  const input =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

  return {
    emotions: normalizeIds(Object.hasOwn(input, 'emotions') ? input.emotions : undefined),
    actions: normalizeIds(Object.hasOwn(input, 'actions') ? input.actions : undefined),
  }
}

export function isPetContextMenuCommand(value: unknown): value is PetContextMenuCommand {
  if (!value || typeof value !== 'object') return false

  const command = value as Record<string, unknown>
  if (!Object.hasOwn(command, 'type')) return false
  if (command.type === 'settings') return true
  if (command.type !== 'emotion' && command.type !== 'action') return false

  return (
    Object.hasOwn(command, 'id') &&
    typeof command.id === 'string' &&
    MENU_ID.test(command.id)
  )
}

export function formatPetMenuLabel(id: string, kind: 'emotion' | 'action'): string {
  const labels = kind === 'emotion' ? EMOTION_LABELS : ACTION_LABELS
  const label = Object.hasOwn(labels, id) ? labels[id] : undefined
  return typeof label === 'string' ? label : id
}
