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
    expect(controlsSource).toContain('input-row')
    expect(controlsSource).not.toContain('toolbar-row')
    expect(descriptor.template?.content).toContain('bubbleText && !agent.chatOpen')
    expect(controlsSource).toContain('role-menu')
    expect(controlsSource).toContain('role-switcher')
    expect(controlsSource).toContain('currentProfile.riskNotice')
    expect(controlsSource).toContain('currentProfile.name')
    expect(controlsSource).toContain('thought-toggle')
    expect(controlsSource).toContain('ref="messageListRef"')
    expect(controlsSource).toContain('chat.toggleThought')
    expect(controlsSource).toContain('分析记录')
    expect(controlsSource).not.toContain('思考过程')
    expect(controlsSource).toContain("message.type === 'status'")
    expect(controlsSource).toContain("$emit('retry', message.requestId)")
    expect(controlsSource).toContain(':disabled="agent.interruptible"')
    expect(controlsSource).toContain('v-model="draftText"')
    expect(controlsSource).toContain('@pointerdown.prevent="$emit(\'voice-start\')"')
    expect(controlsSource).toContain('@click="submit"')
    expect(descriptor.scriptSetup?.content).toContain('watch(messageActivity')
    expect(descriptor.scriptSetup?.content).toContain('list.scrollTop = list.scrollHeight')
    expect(descriptor.scriptSetup?.content).not.toContain('inputOpen')
    expect(descriptor.scriptSetup?.content).not.toContain('conversationOpen')
    expect(descriptor.scriptSetup?.content).not.toContain('interactionOpen')
  })
})
