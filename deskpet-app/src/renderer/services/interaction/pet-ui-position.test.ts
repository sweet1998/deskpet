import { describe, expect, it } from 'vitest'
import { clampPetSurfacePosition, placePetSurface } from './pet-ui-position'

describe('placePetSurface', () => {
  it('places a surface directly to the left of a pet near the right edge', () => {
    expect(placePetSurface({
      viewportWidth: 1512,
      viewportHeight: 890,
      petX: 1210,
      petY: 646,
      petWidth: 204,
      petHeight: 280,
      surfaceWidth: 320,
      surfaceHeight: 98,
    })).toEqual({ left: 774, top: 680 })
  })

  it('moves the surface to the right when there is no room on the left', () => {
    const result = placePetSurface({
      viewportWidth: 900,
      viewportHeight: 700,
      petX: 120,
      petY: 400,
      petWidth: 180,
      petHeight: 260,
      surfaceWidth: 320,
      surfaceHeight: 98,
    })
    expect(result.left).toBe(224)
  })

  it('keeps a dragged surface inside the visible viewport', () => {
    expect(clampPetSurfacePosition({
      left: 880,
      top: -50,
      viewportWidth: 900,
      viewportHeight: 700,
      surfaceWidth: 320,
      surfaceHeight: 420,
    })).toEqual({ left: 568, top: 12 })
  })
})
