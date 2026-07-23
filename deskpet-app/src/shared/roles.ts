import profiles from './role-profiles.json'
import type { NativeToolIntent } from './native-tools'

export const ROLE_IDS = ['default', 'stock_expert'] as const
export type RoleId = typeof ROLE_IDS[number]

export interface RoleProfile {
  roleId: RoleId
  name: string
  icon: 'sparkles' | 'chart-candlestick'
  greeting: string
  systemPrompt: string
  responseStyle: string
  riskNotice: string
  capabilities: string[]
  outOfScopeMessage: string
  emotionBias: string
  actionBias: string
}

export const ROLE_PROFILES = profiles as Record<RoleId, RoleProfile>

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && (ROLE_IDS as readonly string[]).includes(value)
}

export function normalizeRoleId(value: unknown): RoleId {
  return isRoleId(value) ? value : 'default'
}

export function getRoleProfile(value: unknown): RoleProfile {
  return ROLE_PROFILES[normalizeRoleId(value)]
}

const NATIVE_TOOL_CAPABILITY: Record<NativeToolIntent['name'], string> = {
  list_reminders: 'reminder',
  create_reminder: 'reminder',
  cancel_reminder: 'reminder',
  write_clipboard: 'clipboard',
  open_url: 'system_open',
  reveal_path: 'system_open',
}

export function roleCanUseNativeTool(roleId: unknown, tool: NativeToolIntent['name']): boolean {
  return getRoleProfile(roleId).capabilities.includes(NATIVE_TOOL_CAPABILITY[tool])
}
