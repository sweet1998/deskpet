import { describe, expect, it } from 'vitest'
import { LEGAL_CONSENT_KEY, hasLegalConsent } from './legal'

describe('legal consent versioning', () => {
  it('requires consent for the current policy version', () => {
    expect(hasLegalConsent({ getItem: () => null })).toBe(false)
    expect(hasLegalConsent({ getItem: (key) => key === LEGAL_CONSENT_KEY ? '2026-07-22T00:00:00Z' : null })).toBe(true)
  })
})
