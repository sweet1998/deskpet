// @vitest-environment node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { baseParse, NodeTypes, type ElementNode, type TemplateChildNode } from '@vue/compiler-dom'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

function staticClasses(node: ElementNode): string[] {
  return node.props.flatMap((prop) => {
    if (prop.type !== NodeTypes.ATTRIBUTE || prop.name !== 'class') return []
    return prop.value?.content.split(/\s+/) ?? []
  })
}

describe('PetInteraction unified conversation surface', () => {
  it('renders conversation history inside the input controls container', () => {
    const filename = fileURLToPath(new URL('./PetInteraction.vue', import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'))
    const ast = baseParse(descriptor.template?.content ?? '')
    let controls: ElementNode | null = null
    let legacyPanel = false

    function visit(node: TemplateChildNode): void {
      if (node.type === NodeTypes.ELEMENT) {
        const classes = staticClasses(node)
        if (classes.includes('interaction-controls')) controls = node
        if (classes.includes('conversation-panel')) legacyPanel = true
        node.children.forEach(visit)
      }
    }
    ast.children.forEach(visit)

    expect(legacyPanel).toBe(false)
    expect(controls).not.toBeNull()
    const controlsSource = (controls as ElementNode).loc.source
    expect(controlsSource).toContain('conversation-section')
    expect(controlsSource).toContain('agent-status-section')
    expect(controlsSource).toContain('input-row')
    expect(controlsSource).toContain('toolbar-row')
    expect(descriptor.template?.content).toContain('bubbleText && !agent.interactionOpen')
    expect(controlsSource).toContain('role-menu')
    expect(controlsSource).toContain('currentProfile.riskNotice')
    expect(controlsSource).toContain('currentProfile.name }} · 对话')
    expect(controlsSource).toContain('thought-toggle')
    expect(controlsSource).toContain('chat.toggleThought')
    expect(controlsSource).toContain("message.type === 'status'")
    expect(controlsSource).toContain("$emit('retry', message.requestId)")
    expect(controlsSource).toContain(':disabled="agent.interruptible"')
  })
})
