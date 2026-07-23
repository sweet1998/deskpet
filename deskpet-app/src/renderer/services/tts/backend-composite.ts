import type { TTSBackend } from './types'
import { createBrowserTtsBackend } from './backend-browser'

export function createTtsBackend(): TTSBackend {
  return createBrowserTtsBackend()
}
