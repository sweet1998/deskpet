import { describe, expect, it } from 'vitest'
import { isClientPointInsideModel, modelBoundsToClientBounds } from './model-bounds'

function canvasStub() {
  return {
    width: 1200,
    height: 1600,
    getBoundingClientRect: () => ({ left: 20, top: 30, width: 600, height: 400 }),
  }
}

describe('modelBoundsToClientBounds', () => {
  it('converts Pixi renderer coordinates into CSS client coordinates', () => {
    const result = modelBoundsToClientBounds(
      { x: 200, y: 300, width: 400, height: 800 },
      canvasStub(),
    )
    expect(result).toEqual({ x: 120, y: 105, width: 200, height: 200 })
  })

  it('includes each model boundary edge', () => {
    const bounds = { x: 200, y: 300, width: 400, height: 800 }
    const canvas = canvasStub()
    expect(isClientPointInsideModel(bounds, canvas, 120, 205)).toBe(true)
    expect(isClientPointInsideModel(bounds, canvas, 320, 205)).toBe(true)
    expect(isClientPointInsideModel(bounds, canvas, 220, 105)).toBe(true)
    expect(isClientPointInsideModel(bounds, canvas, 220, 305)).toBe(true)
  })

  it('rejects points outside each model boundary edge', () => {
    const bounds = { x: 200, y: 300, width: 400, height: 800 }
    const canvas = canvasStub()
    expect(isClientPointInsideModel(bounds, canvas, 119.9, 205)).toBe(false)
    expect(isClientPointInsideModel(bounds, canvas, 320.1, 205)).toBe(false)
    expect(isClientPointInsideModel(bounds, canvas, 220, 104.9)).toBe(false)
    expect(isClientPointInsideModel(bounds, canvas, 220, 305.1)).toBe(false)
  })
})
