import { describe, expect, it, vi } from 'vitest'
import { useWindowDrag } from './useWindowDrag'

describe('useWindowDrag', () => {
  it('starts after the threshold, sends incremental deltas, and stops on mouseup', () => {
    const dragWindow = vi.fn()
    const { onWindowMouseDown } = useWindowDrag(dragWindow)

    onWindowMouseDown(new MouseEvent('mousedown', { screenX: 100, screenY: 100 }))

    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 102, screenY: 102 }))
    expect(dragWindow).not.toHaveBeenCalled()

    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 108, screenY: 111 }))
    expect(dragWindow).toHaveBeenLastCalledWith(8, 11)

    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 110, screenY: 115 }))
    expect(dragWindow).toHaveBeenLastCalledWith(2, 4)

    document.dispatchEvent(new MouseEvent('mouseup'))
    document.dispatchEvent(new MouseEvent('mousemove', { screenX: 120, screenY: 130 }))
    expect(dragWindow).toHaveBeenCalledTimes(2)
  })
})
