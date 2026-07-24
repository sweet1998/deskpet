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
    const drawer = parse(readFileSync(fileURLToPath(new URL('./ConversationDrawer.vue', import.meta.url)), 'utf8')).descriptor
    const messageList = parse(readFileSync(fileURLToPath(new URL('./ChatMessageList.vue', import.meta.url)), 'utf8')).descriptor
    const drawerSource = drawer.template?.content ?? ''
    const messageSource = messageList.template?.content ?? ''
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
    const controlsSource = (controls as unknown as ElementNode).loc.source
    expect(controlsSource).toContain('conversation-section')
    expect(controlsSource).toContain('input-row')
    expect(controlsSource).toContain('panel-resize-edge top')
    expect(controlsSource).toContain('panel-resize-edge right')
    expect(controlsSource).toContain('panel-resize-corner')
    expect(controlsSource).toContain('startSurfaceResize')
    expect(controlsSource).toContain('<header class="chat-header" @pointerdown="startSurfaceDrag">')
    expect(controlsSource).not.toContain('panel-drag-handle')
    expect(controlsSource).not.toContain('GripHorizontal')
    expect(controlsSource).not.toContain('toolbar-row')
    expect(descriptor.template?.content).toContain('bubbleText && !agent.chatOpen')
    expect(descriptor.template?.content).toContain('@after-leave="$emit(\'chat-after-leave\')"')
    expect(controlsSource).toContain('role-menu')
    expect(controlsSource).toContain('role-switcher')
    expect(controlsSource).toContain('currentProfile.riskNotice')
    expect(controlsSource).toContain('currentProfile.name')
    expect(controlsSource).toContain('ChatMessageList')
    expect(controlsSource).toContain('ref="messageListRef"')
    expect(messageSource).toContain('thought-toggle')
    expect(messageSource).toContain('chat.toggleThought')
    expect(messageSource).toContain('分析记录')
    expect(controlsSource).toContain('.docx,.xlsx')
    expect(messageSource).not.toContain('思考过程')
    expect(messageSource).toContain("message.type === 'status'")
    expect(messageSource).toContain("$emit('retry', message.requestId)")
    expect(messageSource).toContain("$emit('continue-generation', message.id)")
    expect(messageSource).toContain('继续生成')
    expect(messageSource).toContain('waitingForFirstToken')
    expect(messageSource).toContain('generation-placeholder')
    expect(controlsSource).toContain("@continue-generation=\"$emit('continue-generation', $event)\"")
    expect(messageSource).toContain(':disabled="agent.interruptible"')
    expect(controlsSource).toContain('v-model="draftText"')
    expect(controlsSource).toContain('@pointerdown.prevent="$emit(\'voice-start\')"')
    expect(controlsSource).toContain('@click="submit"')
    expect(controlsSource).toContain('@click="closeChat"')
    expect(controlsSource).toContain('ConversationDrawer')
    expect(drawerSource).toContain('session-drawer')
    expect(drawerSource).toContain('filteredConversations')
    expect(controlsSource).toContain('createConversation')
    expect(drawerSource).toContain('deleteConversation')
    expect(drawerSource).toContain('exportConversation')
    expect(controlsSource).toContain('type="file"')
    expect(controlsSource).toContain('attachment-preview')
    expect(controlsSource).toContain('screenshot-preview')
    expect(controlsSource).toContain("$emit('confirm-screenshot')")
    expect(controlsSource).toContain("$emit('cancel-screenshot')")
    expect(controlsSource).toContain('<textarea')
    expect(messageSource).toContain('copyAnswer')
    expect(messageSource).toContain('market-rows')
    expect(messageSource).toContain('formatChange')
    expect(controlsSource).toContain('followup-context')
    expect(messageSource).toContain('followup-target')
    expect(messageSource).toContain('continueQuestion(message.id, message.text)')
    expect(controlsSource).toContain("'输入追问...'")
    expect(controlsSource).toContain('attachment-menu')
    expect(controlsSource).toContain('选择屏幕区域')
    expect(controlsSource).toContain('aiConfig.visionSupported')
    expect(controlsSource).not.toContain('粘贴剪贴板内容')
    expect(controlsSource).not.toContain('查看提醒')
    expect(controlsSource).not.toContain('title="工具"')
    expect(descriptor.scriptSetup?.content).toContain("emit('capture-screen')")
    expect(descriptor.scriptSetup?.content).not.toContain('readNativeClipboard')
    expect(descriptor.scriptSetup?.content).toContain('watch(messageActivity')
    expect(descriptor.scriptSetup?.content).toContain('CHAT_PANEL_SIZE_KEY')
    expect(descriptor.scriptSetup?.content).toContain('clampPetSurfaceSize')
    expect(descriptor.styles[0]?.content).toContain('.conversation-section { min-height: 180px; flex: 1 1 auto;')
    expect(descriptor.scriptSetup?.content).toContain('list.scrollToBottom()')
    expect(messageList.scriptSetup?.content).toContain('list.scrollTop = list.scrollHeight')
    expect(descriptor.scriptSetup?.content).not.toContain('inputOpen')
    expect(descriptor.scriptSetup?.content).not.toContain('conversationOpen')
    expect(descriptor.scriptSetup?.content).not.toContain('interactionOpen')
    expect(descriptor.scriptSetup?.content).toContain('chat.hideChatBubble()')
    expect(descriptor.scriptSetup?.content).toContain("'chat-after-leave': []")
  })
})
