import { describe, expect, it, vi } from 'vitest'
import { useWindowDrag } from './useWindowDrag'

describe('useWindowDrag', () => {
  it('starts after the threshold, sends incremental deltas, and stops on mouseup', () => {
    const dragWindow = vi.fn()
    const { onWindowMouseDown } = useWindowDrag(dragWindow)

    onWindowMouseDown(new MouseEvent('mousedown', { screenX: 100, screenY: 100, buttons: 1 }))

    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 102, screenY: 102, buttons: 1 }))
    expect(dragWindow).not.toHaveBeenCalled()

    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 108, screenY: 111, buttons: 1 }))
    expect(dragWindow).toHaveBeenLastCalledWith(8, 11)

    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 110, screenY: 115, buttons: 1 }))
    expect(dragWindow).toHaveBeenLastCalledWith(2, 4)

    document.dispatchEvent(new MouseEvent('mouseup'))
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 120, screenY: 130, buttons: 1 }))
    expect(dragWindow).toHaveBeenCalledTimes(2)
  })

  it('stops an active drag session when cleanup is called', () => {
    const dragWindow = vi.fn()
    const windowDrag = useWindowDrag(dragWindow)

    windowDrag.onWindowMouseDown(new MouseEvent('mousedown', { screenX: 100, screenY: 100, buttons: 1 }))
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 108, screenY: 111, buttons: 1 }))
    expect(dragWindow).toHaveBeenCalledTimes(1)

    windowDrag.cleanup()
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 110, screenY: 115, buttons: 1 }))
    document.dispatchEvent(new MouseEvent('mouseup'))

    expect(dragWindow).toHaveBeenCalledTimes(1)
  })

  it('reports active state and ends the drag when mousemove has no pressed buttons', () => {
    const dragWindow = vi.fn()
    const onActiveChange = vi.fn()
    const windowDrag = useWindowDrag(dragWindow, onActiveChange)

    windowDrag.onWindowMouseDown(new MouseEvent('mousedown', { screenX: 100, screenY: 100, buttons: 1 }))
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 108, screenY: 111, buttons: 1 }))
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 110, screenY: 115, buttons: 0 }))
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 120, screenY: 130, buttons: 1 }))
    document.dispatchEvent(new MouseEvent('mouseup'))

    expect(dragWindow).toHaveBeenCalledTimes(1)
    expect(onActiveChange.mock.calls).toEqual([[true], [false]])
  })

  it.each([
    { name: 'window blur', dispatch: () => window.dispatchEvent(new Event('blur')) },
    { name: 'document visibility change', dispatch: () => document.dispatchEvent(new Event('visibilitychange')) },
  ])('ends the drag on $name', ({ dispatch }) => {
    const dragWindow = vi.fn()
    const onActiveChange = vi.fn()
    const windowDrag = useWindowDrag(dragWindow, onActiveChange)

    windowDrag.onWindowMouseDown(new MouseEvent('mousedown', { screenX: 100, screenY: 100, buttons: 1 }))
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 108, screenY: 111, buttons: 1 }))
    dispatch()
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 110, screenY: 115, buttons: 1 }))
    document.dispatchEvent(new MouseEvent('mouseup'))

    expect(dragWindow).toHaveBeenCalledTimes(1)
    expect(onActiveChange.mock.calls).toEqual([[true], [false]])
  })

  it('ignores a non-left mousedown', () => {
    const dragWindow = vi.fn()
    const onActiveChange = vi.fn()
    const windowDrag = useWindowDrag(dragWindow, onActiveChange)

    windowDrag.onWindowMouseDown(new MouseEvent('mousedown', {
      button: 2,
      buttons: 2,
      screenX: 100,
      screenY: 100,
    }))
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 108, screenY: 111, buttons: 1 }))
    document.dispatchEvent(new MouseEvent('mouseup'))

    expect(dragWindow).not.toHaveBeenCalled()
    expect(onActiveChange).not.toHaveBeenCalled()
  })
})
