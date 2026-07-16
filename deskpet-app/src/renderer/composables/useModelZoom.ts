import { useDeskpetStore } from '@/stores/deskpet'

export function useModelZoom(
  store: ReturnType<typeof useDeskpetStore>,
  getMousePos: () => { x: number; y: number },
  onZoomChanged: (zoom: number) => void,
) {
  let lastWheelTime = 0

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    if (!store.live2dModel) return
    const now = performance.now()
    if (now - lastWheelTime < 50) return
    lastWheelTime = now
    const factor = e.deltaY > 0 ? 0.92 : 1.08
    const newZoom = Math.max(0.15, Math.min(20.0, store.modelZoom * factor))
    const pos = getMousePos()
    const oldScale = store.live2dModel.scale.x
    const newScale = Math.max(0.01, Math.min(30, oldScale * factor))
    const ratio = newScale / oldScale
    store.live2dModel.position.set(
      pos.x - (pos.x - store.live2dModel.position.x) * ratio,
      pos.y - (pos.y - store.live2dModel.position.y) * ratio,
    )
    store.live2dModel.scale.set(newScale)
    store.modelZoom = newZoom
    store.setModelOffset(0, 0)
    onZoomChanged(newZoom)
  }

  return { onWheel }
}
