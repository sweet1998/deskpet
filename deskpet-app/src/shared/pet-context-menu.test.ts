import { describe, expect, it } from 'vitest'
import {
  formatPetMenuLabel,
  isPetContextMenuCommand,
  normalizePetContextMenuRequest,
} from './pet-context-menu'

describe('normalizePetContextMenuRequest', () => {
  it('trims, validates, deduplicates, and limits IDs', () => {
    const actions = Array.from({ length: 40 }, (_, index) => 'action-' + index)
    const result = normalizePetContextMenuRequest({
      emotions: [' happy ', 'happy', '../bad', 12],
      actions,
    })

    expect(result.emotions).toEqual(['happy'])
    expect(result.actions).toHaveLength(32)
    expect(result.actions[0]).toBe('action-0')
  })

  it('bounds raw array scanning and string normalization work', () => {
    const sparseActions = Array<string>(10_000)
    sparseActions[5_000] = 'jump'

    const result = normalizePetContextMenuRequest({
      emotions: [' '.repeat(1_000_000) + 'happy'],
      actions: sparseActions,
    })

    expect(result).toEqual({ emotions: [], actions: [] })
  })

  it('ignores inherited capability fields', () => {
    const input = Object.create({
      emotions: ['happy'],
      actions: ['jump'],
    })

    expect(normalizePetContextMenuRequest(input)).toEqual({
      emotions: [],
      actions: [],
    })
  })
})

describe('pet context menu commands', () => {
  it('accepts only known command shapes', () => {
    expect(isPetContextMenuCommand({ type: 'settings' })).toBe(true)
    expect(isPetContextMenuCommand({ type: 'emotion', id: 'happy' })).toBe(true)
    expect(isPetContextMenuCommand({ type: 'action', id: 'jump' })).toBe(true)
    expect(isPetContextMenuCommand({ type: 'action', id: '../bad' })).toBe(false)
    expect(isPetContextMenuCommand({ type: 'other' })).toBe(false)
  })

  it('rejects inherited command fields', () => {
    const command = Object.create({ type: 'action', id: 'jump' })
    expect(isPetContextMenuCommand(command)).toBe(false)
  })

  it('uses Chinese labels for known IDs and raw IDs for extensions', () => {
    expect(formatPetMenuLabel('happy', 'emotion')).toBe('开心')
    expect(formatPetMenuLabel('jump', 'action')).toBe('跳跃')
    expect(formatPetMenuLabel('walk', 'action')).toBe('走路')
    expect(formatPetMenuLabel('crawl', 'action')).toBe('爬行')
    expect(formatPetMenuLabel('roll', 'action')).toBe('打滚')
    expect(formatPetMenuLabel('hiyori:wave', 'action')).toBe('hiyori:wave')
    expect(formatPetMenuLabel('constructor', 'action')).toBe('constructor')
    expect(formatPetMenuLabel('__proto__', 'emotion')).toBe('__proto__')
  })
})
