import { describe, expect, it } from 'vitest'
import { nextActiveFocusDuration } from './useProactiveCompanion'

describe('proactive companion activity accounting', () => {
  it('counts recent system activity and caps a delayed sampling interval', () => {
    expect(nextActiveFocusDuration(60_000, 60_000, 30)).toBe(120_000)
    expect(nextActiveFocusDuration(0, 10 * 60_000, 20)).toBe(2 * 60_000)
  })

  it('pauses for short idle periods and resets after a long absence', () => {
    expect(nextActiveFocusDuration(60_000, 60_000, 180)).toBe(60_000)
    expect(nextActiveFocusDuration(60_000, 60_000, 601)).toBe(0)
  })
})
