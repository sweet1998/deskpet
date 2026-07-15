import { describe, expect, it } from 'vitest'
import { shouldIgnoreMouseEvents, shouldPublishCursorPosition } from './mouse-event-policy'

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

describe('shouldPublishCursorPosition', () => {
  const unchangedCursor = {
    cursorX: 120,
    cursorY: 240,
    lastCursorX: 120,
    lastCursorY: 240,
    heartbeatMs: 250,
  }

  it('publishes when the cursor position changes', () => {
    expect(shouldPublishCursorPosition({
      ...unchangedCursor,
      cursorX: 121,
      now: 1_100,
      lastPublishedAt: 1_000,
    })).toBe(true)
  })

  it('does not publish an unchanged position before the heartbeat', () => {
    expect(shouldPublishCursorPosition({
      ...unchangedCursor,
      now: 1_249,
      lastPublishedAt: 1_000,
    })).toBe(false)
  })

  it('publishes an unchanged position at the heartbeat', () => {
    expect(shouldPublishCursorPosition({
      ...unchangedCursor,
      now: 1_250,
      lastPublishedAt: 1_000,
    })).toBe(true)
  })

  it('publishes when the clock moves backward', () => {
    expect(shouldPublishCursorPosition({
      ...unchangedCursor,
      now: 900,
      lastPublishedAt: 1_000,
    })).toBe(true)
  })
})
