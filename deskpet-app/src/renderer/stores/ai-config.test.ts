// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAiConfigStore } from './ai-config'

const api = {
  getDoubaoConfig: vi.fn(),
  saveDoubaoConfig: vi.fn(),
  detectDoubaoCapabilities: vi.fn(),
  clearDoubaoConfig: vi.fn(),
}

describe('AI config store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: api,
    })
  })

  it('loads readiness and detected model capabilities', async () => {
    api.getDoubaoConfig.mockResolvedValue({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'ep-test',
      hasApiKey: true,
      capabilities: {
        model: 'ep-test', checkedAt: 123, text: true, streaming: true, vision: false, errors: {},
      },
    })
    const store = useAiConfigStore()

    await store.load()

    expect(store.ready).toBe(true)
    expect(store.capabilitiesChecked).toBe(true)
    expect(store.textSupported).toBe(true)
    expect(store.visionSupported).toBe(false)
  })

  it('refreshes the saved view after capability detection', async () => {
    const report = {
      model: 'ep-test', checkedAt: 456, text: true, streaming: true, vision: true, errors: {},
    }
    api.detectDoubaoCapabilities.mockResolvedValue(report)
    api.getDoubaoConfig.mockResolvedValue({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'ep-test',
      hasApiKey: true,
      capabilities: report,
    })
    const store = useAiConfigStore()

    await store.detect({ apiKey: 'secret', model: 'ep-test' })

    expect(store.visionSupported).toBe(true)
    expect(api.detectDoubaoCapabilities).toHaveBeenCalledWith({ apiKey: 'secret', model: 'ep-test' })
  })

  it('clears the saved AI credential', async () => {
    api.clearDoubaoConfig.mockResolvedValue(true)
    const store = useAiConfigStore()

    await store.clear()

    expect(store.ready).toBe(false)
    expect(store.config.hasApiKey).toBe(false)
  })
})
