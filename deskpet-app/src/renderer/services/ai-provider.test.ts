import { beforeEach, describe, expect, it } from 'vitest'
import { getAiProvider, setAiProvider } from './ai-provider'

describe('AI provider delivery defaults', () => {
  beforeEach(() => localStorage.clear())

  it('migrates legacy providers to doubao', () => {
    localStorage.setItem('deskpet/ai-provider', 'maibot')

    expect(getAiProvider()).toBe('doubao')
    expect(localStorage.getItem('deskpet/ai-provider')).toBe('doubao')
  })

  it('does not expose programmatic switching in the delivery build', () => {
    setAiProvider('backend')

    expect(getAiProvider()).toBe('doubao')
  })
})
