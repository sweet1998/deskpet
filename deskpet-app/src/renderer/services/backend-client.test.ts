import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getBackendMarketContext,
  getBackendToken,
  getBackendUrl,
  getMarketSource,
  parseSSEBlock,
  streamBackendChat,
  streamResearchPreparation,
  testBackendConnection,
} from './backend-client'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('backend SSE parser', () => {
  it('uses the install-free backend market source by default', () => {
    localStorage.clear()
    expect(getMarketSource()).toBe('backend')
  })

  it('migrates legacy backend settings to the bundled local service', () => {
    localStorage.setItem('deskpet/backend-url', 'https://legacy.example.com')
    localStorage.setItem('deskpet/backend-token', 'legacy-token')

    expect(getBackendUrl()).toBe('http://127.0.0.1:18540')
    expect(getBackendToken()).toBe('')
    expect(localStorage.getItem('deskpet/backend-url')).toBe('http://127.0.0.1:18540')
    expect(localStorage.getItem('deskpet/backend-token')).toBeNull()
  })

  it('parses named events and JSON data', () => {
    expect(parseSSEBlock('event: delta\ndata: {"text":"你好"}')).toEqual({
      event: 'delta',
      data: { text: '你好' },
    })
  })

  it('ignores malformed event payloads', () => {
    expect(parseSSEBlock('event: delta\ndata: not-json')).toBeNull()
  })

  it('delivers research reasoning before the prepared result', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode('event: reasoning\ndata: {"text":"已获取行业快照"}\n\n'),
      encoder.encode('event: reasoning\ndata: {"text":"已完成趋势计算"}\n\n'),
      encoder.encode('event: result\ndata: {"scope":"in_scope","intent":"sector_scan","requiresResearch":true,"targetKind":"sector","targets":[],"thoughts":[]}\n\n'),
    ]
    let index = 0
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => index < chunks.length
            ? { value: chunks[index++], done: false }
            : { value: undefined, done: true },
        }),
      },
    }))
    const reasoning: string[] = []

    const result = await streamResearchPreparation({
      text: '最近什么行情有上涨趋势',
      roleId: 'stock_expert',
      history: [],
    }, async (text) => {
      await Promise.resolve()
      reasoning.push(text)
    })

    expect(reasoning).toEqual(['已获取行业快照', '已完成趋势计算'])
    expect(result.intent).toBe('sector_scan')
  })

  it('adds the main-process token to protected backend requests', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getBackendAccess: vi.fn().mockResolvedValue({
          url: 'http://127.0.0.1:18540',
          token: 'private-session-token',
        }),
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', source: 'test', securities: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await getBackendMarketContext('600519')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18540/v1/market/context',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer private-session-token' }),
      }),
    )
  })

  it('sends a confirmed screenshot through the protected backend stream', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getBackendAccess: vi.fn().mockResolvedValue({
          url: 'http://127.0.0.1:18540',
          token: 'private-session-token',
        }),
      },
    })
    const encoder = new TextEncoder()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => {
          let sent = false
          return {
            read: async () => sent
              ? { value: undefined, done: true }
              : (sent = true, {
                  value: encoder.encode('event: done\ndata: {"requestId":"req-image"}\n\n'),
                  done: false,
                }),
          }
        },
      },
    })
    vi.stubGlobal('fetch', fetchMock)

    await streamBackendChat({
      requestId: 'req-image',
      roleId: 'default',
      text: '分析截图',
      userName: '',
      memories: [],
      history: [],
      image: { mimeType: 'image/png', base64: 'ZmFrZS1wbmc=' },
    }, vi.fn())

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18540/v1/agent/chat',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer private-session-token' }),
        body: expect.stringContaining('"image":{"mimeType":"image/png","base64":"ZmFrZS1wbmc="}'),
      }),
    )
  })

  it.each([
    [
      { ok: true, status: 'ok', source: 'akshare' },
      true,
      '本地研究服务和行情源均可用（akshare）',
    ],
    [
      { ok: true, status: 'degraded', source: 'tencent', stale: true },
      true,
      '本地研究服务可用；行情当前为降级数据（tencent）',
    ],
    [
      { ok: false, status: 'unavailable', error: 'upstream timeout' },
      false,
      '本地研究服务已启动，但行情源不可用：upstream timeout',
    ],
  ])('checks the market provider as part of backend diagnostics', async (market, ok, message) => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getBackendAccess: vi.fn().mockResolvedValue({
          url: 'http://127.0.0.1:18540',
          token: 'private-session-token',
        }),
      },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => market })
    vi.stubGlobal('fetch', fetchMock)

    await expect(testBackendConnection()).resolves.toEqual({ ok, message })
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:18540/v1/market/health',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer private-session-token' }),
      }),
    )
  })
})
