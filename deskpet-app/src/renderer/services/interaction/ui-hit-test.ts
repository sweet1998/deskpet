export function isPointOverVisibleUi(
  root: ParentNode,
  clientX: number,
  clientY: number,
): boolean {
  return Array.from(root.querySelectorAll('[data-pet-ui]')).some((element) => {
    const style = getComputedStyle(element)
    const opacity = Number.parseFloat(style.opacity)
    if (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.visibility === 'collapse'
      || (Number.isFinite(opacity) && opacity <= 0)
    ) return false

    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false

    return (
      clientX >= rect.left
      && clientX <= rect.right
      && clientY >= rect.top
      && clientY <= rect.bottom
    )
  })
}
