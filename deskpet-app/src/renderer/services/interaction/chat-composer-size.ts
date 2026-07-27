export const CHAT_COMPOSER_MIN_HEIGHT = 34
export const CHAT_COMPOSER_MAX_HEIGHT = 72

export function chatComposerHeight(
  value: string,
  scrollHeight: number,
  fitsSingleLine = false,
): number {
  if (!value || fitsSingleLine) return CHAT_COMPOSER_MIN_HEIGHT
  return Math.min(
    CHAT_COMPOSER_MAX_HEIGHT,
    Math.max(CHAT_COMPOSER_MIN_HEIGHT, scrollHeight),
  )
}
