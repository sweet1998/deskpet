export type SecureUserDataNamespace = 'chat' | 'agent'

export interface SecureUserDataReadResult {
  available: boolean
  exists: boolean
  value?: unknown
  error?: string
}
