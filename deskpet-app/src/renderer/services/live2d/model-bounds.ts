export interface BoundsLike {
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasLike {
  width: number
  height: number
  getBoundingClientRect(): {
    left: number
    top: number
    width: number
    height: number
  }
}

export function modelBoundsToClientBounds(bounds: BoundsLike, canvas: CanvasLike): BoundsLike {
  const rect = canvas.getBoundingClientRect()
  const scaleX = rect.width / canvas.width
  const scaleY = rect.height / canvas.height

  return {
    x: rect.left + bounds.x * scaleX,
    y: rect.top + bounds.y * scaleY,
    width: bounds.width * scaleX,
    height: bounds.height * scaleY,
  }
}

export function isClientPointInsideModel(
  bounds: BoundsLike,
  canvas: CanvasLike,
  clientX: number,
  clientY: number,
): boolean {
  const clientBounds = modelBoundsToClientBounds(bounds, canvas)

  return (
    clientX >= clientBounds.x &&
    clientX <= clientBounds.x + clientBounds.width &&
    clientY >= clientBounds.y &&
    clientY <= clientBounds.y + clientBounds.height
  )
}
