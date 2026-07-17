import { describe, expect, it } from 'vitest'
import { normalizeMarketConfig } from './market-bridge'

describe('market bridge config', () => {
  it('accepts loopback bridge addresses and valid OpenD settings', () => {
    expect(normalizeMarketConfig({
      openDHost: '192.168.1.20',
      openDPort: 11112,
      bridgeUrl: 'http://127.0.0.1:18532/context',
    })).toEqual({
      openDHost: '192.168.1.20',
      openDPort: 11112,
      bridgeUrl: 'http://127.0.0.1:18532',
    })
  })

  it('rejects a remote bridge URL and invalid port', () => {
    const result = normalizeMarketConfig({
      openDHost: '',
      openDPort: 99999,
      bridgeUrl: 'https://example.com/market',
    })
    expect(result).toMatchObject({
      openDHost: '127.0.0.1',
      openDPort: 11111,
      bridgeUrl: 'http://127.0.0.1:18531',
    })
  })
})
