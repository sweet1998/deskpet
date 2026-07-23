import type {
  NativePendingTool,
  NativeToolAuditInput,
  NativeToolPlan,
  NativeToolRisk,
} from '../../shared/native-tools'
import type { RoleId } from '../../shared/roles'

export interface NativeToolOperation {
  tool: NativePendingTool
  summary: string
}

export function nativeToolRisk(tool: NativePendingTool): NativeToolRisk {
  return tool.name === 'open_url' || tool.name === 'reveal_path' ? 'medium' : 'low'
}

export function nativeConfirmationExpired(expiresAt: number, now = Date.now()): boolean {
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

export function createNativeToolPlan(
  requestId: string,
  roleId: RoleId,
  goal: string,
  operations: NativeToolOperation[],
): NativeToolPlan {
  return {
    requestId,
    roleId,
    goal,
    steps: operations.map((operation, index) => ({
      id: `${requestId}-step-${index + 1}`,
      tool: operation.tool.name,
      summary: operation.summary,
      risk: nativeToolRisk(operation.tool),
      requiresConfirmation: true,
    })),
  }
}

export async function auditNativeTool(input: NativeToolAuditInput): Promise<void> {
  await window.electronAPI?.appendNativeToolAudit(input)
}

export async function executeNativeTool(tool: NativePendingTool): Promise<string> {
  if (tool.name === 'create_reminder') {
    const result = await window.electronAPI?.createNativeReminder(tool.reminder)
    if (!result || 'error' in result) throw new Error(result?.error || '创建提醒失败')
    return `提醒已设置：${new Date(result.dueAt).toLocaleString('zh-CN')}，${result.body}`
  }
  if (tool.name === 'cancel_reminder') {
    if (!await window.electronAPI?.cancelNativeReminder(tool.reminderId)) throw new Error('提醒不存在或已经触发')
    return `已取消提醒：${tool.summary}`
  }
  if (tool.name === 'write_clipboard') {
    if (!await window.electronAPI?.writeNativeClipboard(tool.text)) throw new Error('写入剪贴板失败')
    return '已写入剪贴板。'
  }
  if (tool.name === 'open_url') {
    if (!await window.electronAPI?.openNativeUrl(tool.url)) throw new Error('无法打开该网页')
    return '已使用默认浏览器打开网页。'
  }
  if (!await window.electronAPI?.revealNativePath(tool.path)) throw new Error('文件不存在或无法在 Finder 中显示')
  return '已在 Finder 中显示该文件。'
}
