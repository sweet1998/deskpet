export type DragWindow = (dx: number, dy: number) => void
export type DragActiveChange = (active: boolean) => void

const dragWindowWithIpc: DragWindow = (dx, dy) => {
  void window.electronAPI?.dragWindow(dx, dy)
}

export function useWindowDrag(
  dragWindow: DragWindow = dragWindowWithIpc,
  onActiveChange?: DragActiveChange,
) {
  let cleanupActiveDrag: (() => void) | null = null
  let active = false

  function setActive(nextActive: boolean) {
    if (active === nextActive) return
    active = nextActive
    onActiveChange?.(active)
  }

  function cleanup() {
    const removeListeners = cleanupActiveDrag
    cleanupActiveDrag = null
    removeListeners?.()
    setActive(false)
  }

  function onWindowMouseDown(e: MouseEvent) {
    if (e.button !== 0) return
    cleanup()

    let lastX = e.screenX
    let lastY = e.screenY
    let moved = false

    const onMove = (ev: MouseEvent) => {
      if (ev.buttons === 0) {
        cleanup()
        return
      }
      const dx = ev.screenX - lastX
      const dy = ev.screenY - lastY
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      moved = true
      dragWindow(dx, dy)
      lastX = ev.screenX
      lastY = ev.screenY
    }

    const onUp = () => {
      cleanup()
    }

    cleanupActiveDrag = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onUp)
      document.removeEventListener('visibilitychange', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onUp)
    document.addEventListener('visibilitychange', onUp)
    setActive(true)
  }

  return { onWindowMouseDown, onNavMouseDown: onWindowMouseDown, cleanup }
}
