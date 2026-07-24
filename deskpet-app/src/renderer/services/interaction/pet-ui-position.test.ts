import { describe, expect, it } from 'vitest'
import { clampPetSurfacePosition, clampPetSurfaceSize, placePetSurface } from './pet-ui-position'

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

  it('keeps a resized surface between its minimum and the visible viewport edge', () => {
    expect(clampPetSurfaceSize({
      width: 900,
      height: 100,
      left: 120,
      top: 80,
      viewportWidth: 900,
      viewportHeight: 700,
    })).toEqual({ width: 768, height: 280 })
  })

  it('supports a fixed bottom edge when resizing from the top', () => {
    expect(clampPetSurfaceSize({
      width: 420,
      height: 900,
      left: 100,
      top: 0,
      viewportWidth: 900,
      viewportHeight: 700,
      maxHeight: 548,
    })).toEqual({ width: 420, height: 548 })
  })
})
