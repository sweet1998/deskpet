import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPointOverVisibleUi } from './ui-hit-test'

function mockRect(
  element: Element,
  { left, top, width, height }: { left: number; top: number; width: number; height: number },
): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect)
}

function createMarkedElement(
  root: HTMLElement,
  style: Partial<CSSStyleDeclaration> = {},
): HTMLDivElement {
  const element = document.createElement('div')
  element.setAttribute('data-pet-ui', '')
  Object.assign(element.style, style)
  root.appendChild(element)
  return element
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('isPointOverVisibleUi', () => {
  it('hits a visible marked rectangle using closed boundaries', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const element = createMarkedElement(root)
    mockRect(element, { left: 10, top: 20, width: 100, height: 50 })

    expect(isPointOverVisibleUi(root, 10, 20)).toBe(true)
    expect(isPointOverVisibleUi(root, 110, 70)).toBe(true)
    expect(isPointOverVisibleUi(root, 9, 20)).toBe(false)
    expect(isPointOverVisibleUi(root, 111, 70)).toBe(false)
  })

  it('hits a marked rectangle with pointer-events none', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const element = createMarkedElement(root, { pointerEvents: 'none' })
    mockRect(element, { left: 10, top: 20, width: 100, height: 50 })

    expect(isPointOverVisibleUi(root, 50, 40)).toBe(true)
  })

  it('ignores an unmarked overlay and only hits its marked panel', () => {
    const root = document.createElement('div')
    const overlay = document.createElement('div')
    const panel = createMarkedElement(overlay)
    root.appendChild(overlay)
    document.body.appendChild(root)
    mockRect(overlay, { left: 0, top: 0, width: 600, height: 800 })
    mockRect(panel, { left: 320, top: 0, width: 280, height: 800 })

    expect(isPointOverVisibleUi(root, 100, 200)).toBe(false)
    expect(isPointOverVisibleUi(root, 400, 200)).toBe(true)
  })

  it.each([
    { name: 'display none', style: { display: 'none' } },
    { name: 'visibility hidden', style: { visibility: 'hidden' } },
    { name: 'zero opacity', style: { opacity: '0' } },
  ])('ignores a marked rectangle with $name', ({ style }) => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const element = createMarkedElement(root, style)
    mockRect(element, { left: 10, top: 20, width: 100, height: 50 })

    expect(isPointOverVisibleUi(root, 50, 40)).toBe(false)
  })
})
