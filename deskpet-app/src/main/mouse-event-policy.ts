export interface MouseEventPolicyState {
  clickThroughLocked: boolean
  pointerInteractive: boolean
}

export function shouldIgnoreMouseEvents({
  clickThroughLocked,
  pointerInteractive,
}: MouseEventPolicyState): boolean {
  return clickThroughLocked || !pointerInteractive
}
