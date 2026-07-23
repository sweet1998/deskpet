// @vitest-environment node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('stock expert research routing', () => {
  it('uses server preparation and only creates thoughts for research requests', () => {
    const filename = fileURLToPath(new URL('./chimera.ts', import.meta.url))
    const source = readFileSync(filename, 'utf8')

    expect(source).toContain('await streamResearchPreparation')
    expect(source).toContain('REASONING_STEP_INTERVAL_MS')
    expect(source).toContain('await presentReasoning(requestId, roleId, thought)')
    expect(source).toContain("prepared.scope !== 'in_scope'")
    expect(source).toContain("research: prepared")
    expect(source).toContain('compactResearchContext')
    expect(source).toContain('onDoubaoChatDelta')
    expect(source).toContain("chat.appendChatText(delta, requestId)")
    expect(source).toContain('message.id !== `user-${requestId}`')
    expect(source).toContain("{ role: 'user', content: userContent }")
    expect(source).toContain('createNativeToolTransport')
    expect(source).toContain('nativeTools.handleIntent(text, requestId, roleId)')
    expect(source).toContain('nativeTools.resolveConfirmation(requestId, allowed)')
    expect(source).toContain("{ type: 'image_url'")
    expect(source).toContain('当前豆包模型不支持图片输入')
    expect(source).toContain('!imageUnsupported')
    expect(source).toContain("{ mimeType: 'image/png', base64 }")
    expect(source).not.toContain('当前后端模式暂不支持截图理解')
    expect(source).not.toContain("chat.appendThought(requestId, '正在识别问题意图和分析目标')")
    expect(source).not.toContain("chat.appendThought(requestId, '正在整理事实、分析依据、主要风险和观察条件')")
    expect(source).not.toContain('for (const thought of prepared.thoughts)')
    expect(source).not.toContain('chat.appendThought(requestId, thought)')

    const websocketFilename = fileURLToPath(new URL('../../composables/useWebSocket.ts', import.meta.url))
    const websocketSource = readFileSync(websocketFilename, 'utf8')
    expect(websocketSource).not.toContain("appendThought(responseRequestId, '正在理解问题和分析目标')")
    expect(websocketSource).not.toMatch(/typeof data\.step[\s\S]{0,120}appendThought/)

    const nativeToolsFilename = fileURLToPath(new URL('../native-tool-transport.ts', import.meta.url))
    const nativeToolsSource = readFileSync(nativeToolsFilename, 'utf8')
    expect(nativeToolsSource).toContain('parseNativeToolIntents')
    expect(nativeToolsSource).toContain('shouldPlanNativeTools')
    expect(nativeToolsSource).toContain('planNativeTools({ text: originalText })')
    expect(nativeToolsSource).toContain('roleCanUseNativeTool')
    expect(nativeToolsSource).toContain('createNativeToolPlan')
    expect(nativeToolsSource).toContain('executeNativeTool as runNativeTool')
    expect(nativeToolsSource).toContain('const reply = await runNativeTool(operation.tool)')
    expect(nativeToolsSource).toContain('pending.stepIndex += 1')
    expect(nativeToolsSource).toContain('presentConfirmation(requestId, pending)')
    expect(nativeToolsSource).toContain('async function resolveConfirmation(requestId: string, allowed: boolean)')
    expect(nativeToolsSource).toContain('nativeConfirmationExpired(pending.expiresAt)')
    expect(nativeToolsSource).toContain('auditNativeTool')
    expect(nativeToolsSource).toContain('pendingTools')
  })
})
