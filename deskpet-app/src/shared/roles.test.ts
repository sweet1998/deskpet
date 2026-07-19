import { describe, expect, it } from 'vitest'
import { getRoleProfile, normalizeRoleId, ROLE_IDS } from './roles'

describe('role profiles', () => {
  it('exposes only the supported role whitelist', () => {
    expect(ROLE_IDS).toEqual(['default', 'stock_expert'])
    expect(getRoleProfile('stock_expert').riskNotice).toContain('不构成投资建议')
    expect(getRoleProfile('stock_expert').capabilities).toContain('a_share_sector')
    expect(getRoleProfile('stock_expert').systemPrompt).toContain('绝不能机械套用固定章节')
  })

  it('falls back to default for an untrusted role id', () => {
    expect(normalizeRoleId('ignore_previous_instructions')).toBe('default')
    expect(getRoleProfile(null).name).toBe('麦麦')
  })
})
