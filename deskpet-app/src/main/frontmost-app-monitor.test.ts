import { describe, expect, it } from 'vitest'
import {
  desktopVisibilityForBundle,
  normalizeFrontmostBundleId,
} from './frontmost-app-monitor'

describe('desktop-only visibility', () => {
  const own = new Set(['com.sweet1998.deskpet', 'com.github.Electron'])

  it('shows on Finder and while the deskpet itself is active', () => {
    expect(desktopVisibilityForBundle('com.apple.finder', own)).toBe(true)
    expect(desktopVisibilityForBundle('com.sweet1998.deskpet', own)).toBe(true)
  })

  it('hides for other applications and ignores transient Dock activation', () => {
    expect(desktopVisibilityForBundle('com.google.Chrome', own)).toBe(false)
    expect(desktopVisibilityForBundle('com.apple.dock', own)).toBeNull()
  })

  it('accepts only standalone bundle identifier output', () => {
    expect(normalizeFrontmostBundleId('com.apple.finder\n')).toBe('com.apple.finder')
    expect(normalizeFrontmostBundleId('execution error: failed')).toBeNull()
  })
})
