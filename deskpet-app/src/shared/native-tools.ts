export interface NativeFileExtractionInput {
  name: string
  mimeType: string
  size: number
  base64: string
}

export interface NativeFileExtractionResult {
  ok: boolean
  name: string
  text?: string
  characters?: number
  truncated?: boolean
  error?: string
}

export type NativeReminderStatus = 'scheduled' | 'delivered' | 'cancelled'

export interface NativeReminder {
  id: string
  title: string
  body: string
  dueAt: number
  createdAt: number
  status: NativeReminderStatus
}

export interface NativeReminderInput {
  title: string
  body: string
  dueAt: number
}

export type NativeToolName =
  | 'extract_file'
  | 'capture_screen'
  | 'list_reminders'
  | 'create_reminder'
  | 'cancel_reminder'
  | 'write_clipboard'
  | 'open_url'
  | 'reveal_path'

export type NativeToolRisk = 'low' | 'medium'
export type NativeToolAuditStatus =
  | 'requested'
  | 'awaiting_confirmation'
  | 'denied'
  | 'succeeded'
  | 'failed'

export interface NativeToolPlanStep {
  id: string
  tool: NativeToolName
  summary: string
  risk: NativeToolRisk
  requiresConfirmation: boolean
}

export interface NativeToolPlan {
  requestId: string
  roleId: 'default' | 'stock_expert'
  goal: string
  steps: NativeToolPlanStep[]
}

export interface NativeToolAuditInput {
  requestId: string
  roleId: 'default' | 'stock_expert'
  tool: NativeToolName
  summary: string
  status: NativeToolAuditStatus
  error?: string
}

export interface NativeToolAuditEntry extends NativeToolAuditInput {
  id: string
  timestamp: number
}

export type NativePendingTool =
  | { name: 'create_reminder'; reminder: NativeReminderInput }
  | { name: 'cancel_reminder'; reminderId: string; summary: string }
  | { name: 'write_clipboard'; text: string }
  | { name: 'open_url'; url: string }
  | { name: 'reveal_path'; path: string }

export interface NativeToolIntent {
  kind: 'immediate' | 'confirmation'
  name: 'list_reminders' | NativePendingTool['name']
  summary: string
  pending?: NativePendingTool
}

export interface NativeToolPlanningRequest {
  text: string
}

export interface NativeToolPlanningResult {
  intents: NativeToolIntent[]
  error?: string
}
