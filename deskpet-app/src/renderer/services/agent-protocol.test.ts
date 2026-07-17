import { describe, expect, it } from 'vitest'
import { isAgentState } from './agent-protocol'

describe('agent protocol', () => {
  it('accepts every supported lifecycle state', () => {
    for (const state of [
      'idle', 'listening', 'thinking', 'planning', 'executing',
      'awaiting_confirmation', 'speaking', 'success', 'error', 'interrupted',
    ]) {
      expect(isAgentState(state)).toBe(true)
    }
  })

  it('rejects unknown and non-string states', () => {
    expect(isAgentState('running')).toBe(false)
    expect(isAgentState(null)).toBe(false)
  })
})

