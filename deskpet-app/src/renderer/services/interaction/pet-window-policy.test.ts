import { describe, expect, it } from 'vitest'
import { shouldPetWindowBeInteractive } from './pet-window-policy'

describe('shouldPetWindowBeInteractive', () => {
  it.each([
    {
      name: 'accepts the rendered model',
      state: {
        dragActive: false,
        pointOverModel: true,
        settingsOpen: false,
        pointOverSettings: false,
      },
      expected: true,
    },
    {
      name: 'passes through normal transparent space',
      state: {
        dragActive: false,
        pointOverModel: false,
        settingsOpen: false,
        pointOverSettings: false,
      },
      expected: false,
    },
    {
      name: 'ignores a settings rectangle while settings are closed',
      state: {
        dragActive: false,
        pointOverModel: false,
        settingsOpen: false,
        pointOverSettings: true,
      },
      expected: false,
    },
    {
      name: 'accepts the visible settings panel after an explicit open command',
      state: {
        dragActive: false,
        pointOverModel: false,
        settingsOpen: true,
        pointOverSettings: true,
      },
      expected: true,
    },
    {
      name: 'keeps receiving the pointer for an active drag',
      state: {
        dragActive: true,
        pointOverModel: false,
        settingsOpen: false,
        pointOverSettings: false,
      },
      expected: true,
    },
  ])('$name', ({ state, expected }) => {
    expect(shouldPetWindowBeInteractive(state)).toBe(expected)
  })
})
