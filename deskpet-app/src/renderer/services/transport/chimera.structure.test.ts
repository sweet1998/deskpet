// @vitest-environment node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('stock expert research routing', () => {
  it('uses server preparation and only creates thoughts for research requests', () => {
    const filename = fileURLToPath(new URL('./chimera.ts', import.meta.url))
    const source = readFileSync(filename, 'utf8')

    expect(source).toContain('await prepareResearch')
    expect(source).toContain("prepared.scope !== 'in_scope'")
    expect(source).toContain('prepared.requiresResearch')
    expect(source).toContain("research: prepared")
    expect(source).not.toContain("chat.appendThought(requestId, '正在识别问题意图和分析目标')")
    expect(source).not.toContain("chat.appendThought(requestId, '正在整理事实、分析依据、主要风险和观察条件')")

    const websocketFilename = fileURLToPath(new URL('../../composables/useWebSocket.ts', import.meta.url))
    const websocketSource = readFileSync(websocketFilename, 'utf8')
    expect(websocketSource).not.toContain("appendThought(responseRequestId, '正在理解问题和分析目标')")
    expect(websocketSource).not.toMatch(/typeof data\.step[\s\S]{0,120}appendThought/)
  })
})
