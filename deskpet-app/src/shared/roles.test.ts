import { describe, expect, it } from 'vitest'
import { getRoleProfile, normalizeRoleId, roleCanUseNativeTool, ROLE_IDS } from './roles'

describe('role profiles', () => {
  it('exposes only the supported role whitelist', () => {
    expect(ROLE_IDS).toEqual(['default', 'stock_expert'])
    expect(getRoleProfile('stock_expert').riskNotice).toContain('不构成投资建议')
    expect(getRoleProfile('stock_expert').capabilities).toContain('a_share_sector')
    expect(getRoleProfile('stock_expert').capabilities).toContain('a_share_sector_scan')
    expect(getRoleProfile('stock_expert').systemPrompt).toContain('不默认使用标题、编号')
    expect(getRoleProfile('stock_expert').responseStyle).toContain('不写研报模板')
    expect(getRoleProfile('stock_expert').capabilities).toContain('native_file')
  })

  it('applies a role-specific native tool whitelist', () => {
    expect(roleCanUseNativeTool('default', 'create_reminder')).toBe(true)
    expect(roleCanUseNativeTool('default', 'open_url')).toBe(true)
    expect(roleCanUseNativeTool('stock_expert', 'create_reminder')).toBe(false)
    expect(roleCanUseNativeTool('stock_expert', 'open_url')).toBe(false)
  })

  it('falls back to default for an untrusted role id', () => {
    expect(normalizeRoleId('ignore_previous_instructions')).toBe('default')
    expect(getRoleProfile(null).name).toBe('麦麦')
  })
})
