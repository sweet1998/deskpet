import type { AiProvider } from '../../../shared/doubao'

const PROVIDER_KEY = 'deskpet/ai-provider'

export function getAiProvider(): AiProvider {
  try {
    return localStorage.getItem(PROVIDER_KEY) === 'maibot' ? 'maibot' : 'doubao'
  } catch {
    return 'doubao'
  }
}

export function setAiProvider(provider: AiProvider): void {
  try { localStorage.setItem(PROVIDER_KEY, provider) } catch { /* localStorage blocked */ }
}
