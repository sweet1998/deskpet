export interface PetSurfacePlacementInput {
  viewportWidth: number
  viewportHeight: number
  petX: number
  petY: number
  petWidth: number
  petHeight: number
  surfaceWidth: number
  surfaceHeight: number
  gap?: number
  margin?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function placePetSurface(input: PetSurfacePlacementInput) {
  const gap = input.gap ?? 14
  const margin = input.margin ?? 12
  const petLeft = input.petX - input.petWidth / 2
  const petRight = input.petX + input.petWidth / 2
  const leftCandidate = petLeft - gap - input.surfaceWidth
  const rightCandidate = petRight + gap
  const maxLeft = Math.max(margin, input.viewportWidth - input.surfaceWidth - margin)
  const left = leftCandidate >= margin
    ? leftCandidate
    : clamp(rightCandidate, margin, maxLeft)
  const petBottom = input.petY + input.petHeight / 2
  const maxTop = Math.max(margin, input.viewportHeight - input.surfaceHeight - margin)
  const top = clamp(petBottom - input.surfaceHeight - 8, margin, maxTop)

  return { left: Math.round(left), top: Math.round(top) }
}

export function clampPetSurfacePosition(input: {
  left: number
  top: number
  viewportWidth: number
  viewportHeight: number
  surfaceWidth: number
  surfaceHeight: number
  margin?: number
}) {
  const margin = input.margin ?? 12
  return {
    left: Math.round(clamp(
      input.left,
      margin,
      Math.max(margin, input.viewportWidth - input.surfaceWidth - margin),
    )),
    top: Math.round(clamp(
      input.top,
      margin,
      Math.max(margin, input.viewportHeight - input.surfaceHeight - margin),
    )),
  }
}
