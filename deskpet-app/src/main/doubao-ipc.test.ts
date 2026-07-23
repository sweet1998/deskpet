// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveE2eDoubaoBaseUrl } from './doubao-ipc'

describe('Doubao IPC E2E endpoint isolation', () => {
  it('only allows loopback HTTP overrides in explicit E2E runs', () => {
    expect(resolveE2eDoubaoBaseUrl(undefined, 'http://127.0.0.1:19000/v1')).toBeUndefined()
    expect(resolveE2eDoubaoBaseUrl('/tmp/result.json', 'https://example.com/v1')).toBeUndefined()
    expect(resolveE2eDoubaoBaseUrl('/tmp/result.json', 'http://127.0.0.1:19000/v1/'))
      .toBe('http://127.0.0.1:19000/v1')
  })
})
