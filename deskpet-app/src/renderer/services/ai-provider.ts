import type { AiProvider } from '../../shared/doubao'

const PROVIDER_KEY = 'deskpet/ai-provider'

export function getAiProvider(): AiProvider {
  try {
    const provider = localStorage.getItem(PROVIDER_KEY)
    return provider === 'maibot' || provider === 'backend' ? provider : 'doubao'
  } catch {
    return 'doubao'
  }
}

export function setAiProvider(provider: AiProvider): void {
  try { localStorage.setItem(PROVIDER_KEY, provider) } catch { /* localStorage blocked */ }
}
