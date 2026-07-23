export const LEGAL_CONSENT_VERSION = '2026-07-22'
export const LEGAL_CONSENT_KEY = `deskpet/legal-consent/${LEGAL_CONSENT_VERSION}`
export const FEEDBACK_URL = 'https://github.com/sweet1998/deskpet/issues/new?template=bug_report.yml'

export function hasLegalConsent(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  return Boolean(storage.getItem(LEGAL_CONSENT_KEY))
}
