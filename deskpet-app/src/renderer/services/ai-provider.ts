import type { AiProvider } from '../../shared/doubao'

const PROVIDER_KEY = 'deskpet/ai-provider'

export function getAiProvider(): AiProvider {
  try { localStorage.setItem(PROVIDER_KEY, 'doubao') } catch { /* localStorage blocked */ }
  return 'doubao'
}

export function setAiProvider(_provider: AiProvider): void {
  try { localStorage.setItem(PROVIDER_KEY, 'doubao') } catch { /* localStorage blocked */ }
}
