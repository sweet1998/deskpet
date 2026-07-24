export const CHAT_COMPOSER_MIN_HEIGHT = 34
export const CHAT_COMPOSER_MAX_HEIGHT = 88

export function chatComposerHeight(value: string, scrollHeight: number): number {
  if (!value) return CHAT_COMPOSER_MIN_HEIGHT
  return Math.min(
    CHAT_COMPOSER_MAX_HEIGHT,
    Math.max(CHAT_COMPOSER_MIN_HEIGHT, scrollHeight),
  )
}
