export interface MouseEventPolicyState {
  clickThroughLocked: boolean
  pointerInteractive: boolean
}

export interface CursorPublishPolicyState {
  cursorX: number
  cursorY: number
  lastCursorX: number | null
  lastCursorY: number | null
  now: number
  lastPublishedAt: number | null
  heartbeatMs: number
}

export function shouldIgnoreMouseEvents({
  clickThroughLocked,
  pointerInteractive,
}: MouseEventPolicyState): boolean {
  return clickThroughLocked || !pointerInteractive
}

export function shouldPublishCursorPosition({
  cursorX,
  cursorY,
  lastCursorX,
  lastCursorY,
  now,
  lastPublishedAt,
  heartbeatMs,
}: CursorPublishPolicyState): boolean {
  if (cursorX !== lastCursorX || cursorY !== lastCursorY) return true
  if (lastPublishedAt === null || now < lastPublishedAt) return true
  return now - lastPublishedAt >= heartbeatMs
}
