import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MODEL_VIEW_STATE,
  migratePersistedModelViewState
} from './model-view-state'

describe('migratePersistedModelViewState', () => {
  it('preserves a valid zoom and clears legacy offsets', () => {
    expect(
      migratePersistedModelViewState({
        zoom: 1.25,
        offsetX: -543,
        offsetY: 80
      })
    ).toEqual({
      zoom: 1.25,
      offsetX: 0,
      offsetY: 0
    })
  })

  it('uses the default state when zoom is invalid', () => {
    expect(migratePersistedModelViewState({ zoom: 'large' })).toEqual(
      DEFAULT_MODEL_VIEW_STATE
    )
  })

  it.each([NaN, Infinity, -Infinity])(
    'uses the default state when zoom is %s',
    (zoom) => {
      expect(migratePersistedModelViewState({ zoom })).toEqual(
        DEFAULT_MODEL_VIEW_STATE
      )
    }
  )

  it('returns a fresh default state for null', () => {
    const state = migratePersistedModelViewState(null)

    expect(state).toEqual(DEFAULT_MODEL_VIEW_STATE)
    expect(state).not.toBe(DEFAULT_MODEL_VIEW_STATE)
  })
})
