import { describe, expect, it } from 'vitest'
import { shouldIgnoreMouseEvents } from './mouse-event-policy'

describe('shouldIgnoreMouseEvents', () => {
  it.each([
    { clickThroughLocked: false, pointerInteractive: true, expected: false },
    { clickThroughLocked: false, pointerInteractive: false, expected: true },
    { clickThroughLocked: true, pointerInteractive: true, expected: true },
    { clickThroughLocked: true, pointerInteractive: false, expected: true },
  ])(
    'returns $expected when clickThroughLocked=$clickThroughLocked and pointerInteractive=$pointerInteractive',
    ({ clickThroughLocked, pointerInteractive, expected }) => {
      expect(shouldIgnoreMouseEvents({ clickThroughLocked, pointerInteractive })).toBe(expected)
    },
  )
})
