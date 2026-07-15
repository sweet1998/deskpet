import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useDeskpetStore } from './deskpet'

const MODEL_VIEW_STATE_KEY = 'deskpet/model-view'

describe('useDeskpetStore', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('preserves migrated model view state when persistence fails', () => {
    localStorage.setItem(
      MODEL_VIEW_STATE_KEY,
      JSON.stringify({ zoom: 1.25, offsetX: -543, offsetY: 80 })
    )
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key) => {
      if (key === MODEL_VIEW_STATE_KEY) {
        throw new Error('storage unavailable')
      }
    })
    setActivePinia(createPinia())

    const store = useDeskpetStore()

    expect(store.modelZoom).toBe(1.25)
    expect(store.modelOffsetX).toBe(0)
    expect(store.modelOffsetY).toBe(0)
  })
})
