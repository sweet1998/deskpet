export const INLINE_BAR_LIMIT = 40
export const EXPANDED_BAR_LIMIT = 60
export const INLINE_MIN_BARS = 30

export interface ChartLayout {
  barLimit: number
  showAxes: boolean
  showVolume: boolean
}

/**
 * The chat panel can shrink to roughly 225px of usable width, which is too narrow
 * for price/time axes, so the inline chart degrades to a sparkline.
 */
export function chartLayout(containerWidth: number, expanded: boolean): ChartLayout {
  if (expanded) return { barLimit: EXPANDED_BAR_LIMIT, showAxes: true, showVolume: true }
  const perBar = 7
  const fits = Math.floor(Math.max(0, containerWidth) / perBar)
  return {
    barLimit: Math.max(INLINE_MIN_BARS, Math.min(INLINE_BAR_LIMIT, fits)),
    showAxes: false,
    showVolume: false,
  }
}
