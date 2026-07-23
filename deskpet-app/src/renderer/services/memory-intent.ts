export type MemoryIntent =
  | { kind: 'remember'; value: string }
  | { kind: 'forget'; value: string }
  | { kind: 'forget_all' }
  | { kind: 'list' }
  | { kind: 'set_name'; value: string }

function clean(value: string, limit: number): string {
  return value.replace(/^[：:\s]+|[，,。.!！\s]+$/g, '').trim().slice(0, limit)
}

export function parseMemoryIntent(text: string): MemoryIntent | null {
  const source = text.trim()
  if (!source) return null
  if (/^(?:你)?(?:还)?记得(?:我)?什么|^(?:查看|列出|告诉我).{0,6}(?:长期)?记忆/.test(source)) {
    return { kind: 'list' }
  }
  const name = source.match(/^(?:以后)?(?:请)?(?:叫我|称呼我为|我的称呼是)[：:\s]*(.+)$/)
  if (name) {
    const value = clean(name[1], 80)
    return value ? { kind: 'set_name', value } : null
  }
  if (/^(?:请|帮我|麻烦)?(?:忘掉|忘记|清除|删除)(?:所有|全部)(?:长期)?记忆/.test(source)) {
    return { kind: 'forget_all' }
  }
  const forget = source.match(/^(?:请|帮我|麻烦)?(?:忘掉|忘记|删除)(?:关于)?[：:\s]*(.+?)(?:这条)?(?:记忆)?$/)
  if (forget) {
    const value = clean(forget[1], 500)
    return value ? { kind: 'forget', value } : null
  }
  const remember = source.match(/^(?:请|帮我|麻烦)?(?:记住|记一下|记下来)[：:\s]*(.+)$/)
  if (remember) {
    const value = clean(remember[1], 500)
    if (!value || /^(?:了?吗|没有|什么)$/.test(value)) return null
    return { kind: 'remember', value }
  }
  return null
}
