// @vitest-environment node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  baseParse,
  NodeTypes,
  type ElementNode,
  type RootNode,
  type TemplateChildNode,
} from '@vue/compiler-dom'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

function findElementByStaticClass(root: RootNode, className: string): ElementNode {
  const matches: ElementNode[] = []

  function visit(node: RootNode | TemplateChildNode): void {
    if (node.type === NodeTypes.ROOT || node.type === NodeTypes.ELEMENT) {
      if (node.type === NodeTypes.ELEMENT) {
        const classNames = node.props.flatMap((prop) => {
          if (prop.type !== NodeTypes.ATTRIBUTE || prop.name !== 'class') return []
          return prop.value?.content.split(/\s+/) ?? []
        })

        if (classNames.includes(className)) matches.push(node)
      }

      for (const child of node.children) visit(child)
    }
  }

  visit(root)
  expect(matches).toHaveLength(1)
  return matches[0]
}

function hasStoppedMousedown(element: ElementNode): boolean {
  return element.props.some(
    (prop) =>
      prop.type === NodeTypes.DIRECTIVE &&
      prop.name === 'on' &&
      prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
      prop.arg.isStatic &&
      prop.arg.content === 'mousedown' &&
      prop.modifiers.some((modifier) => modifier.content === 'stop'),
  )
}

function hasStaticAttribute(element: ElementNode, name: string): boolean {
  return element.props.some(
    (prop) => prop.type === NodeTypes.ATTRIBUTE && prop.name === name,
  )
}

describe('SettingsPanel pointer event boundary', () => {
  it('stops mousedown only inside the visible settings panel', () => {
    const filename = fileURLToPath(new URL('./SettingsPanel.vue', import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'))
    const template = descriptor.template?.content ?? ''
    const ast = baseParse(template)
    const overlay = findElementByStaticClass(ast, 'settings-overlay')
    const panel = findElementByStaticClass(ast, 'settings-panel')

    expect(hasStoppedMousedown(overlay)).toBe(false)
    expect(hasStoppedMousedown(panel)).toBe(true)
    expect(hasStaticAttribute(panel, 'data-pet-ui')).toBe(true)
    expect(template).toContain('默认角色')
    expect(template).toContain('豆包 API Key')
    expect(template).toContain('本地研究服务')
    expect(template).not.toContain('MaiBot 连接')
    expect(template).not.toContain('MaiBot')
    expect(template).not.toContain('富途 OpenD')
    expect(template).toContain('检测能力')
    expect(template).toContain('capability-list')
    expect(template).toContain('advanced-settings')
    expect(template).toContain('检查更新')
    expect(template).toContain('验证并完成')
    expect(template).toContain('openDoubaoConsole')
    expect(template).toContain('v-if="!onboarding"')
    expect(template).toContain('finishOnboarding')
    expect(template).toContain('reminder-section')
    expect(template).toContain('scheduledReminders')
    expect(template).toContain('cancelReminder(reminder.id)')
    expect(template).toContain('隐私模式')
    expect(template).toContain('clearLocalData')
    expect(template).toContain('clearAiCredential')
    expect(template).toContain('最近系统操作')
    expect(template).toContain('toolAudit')
    expect(template).toContain('agent.voiceReplyEnabled')
    expect(template).toContain('@click="exportDiagnostics"')
    expect(template).toContain('@click="checkVoicePermissions"')
    expect(template).toContain('macOS 系统语音')
    expect(template).toContain('localDataSecurityText')
    expect(template).toContain('最多保留 40 个会话')
    expect(template).toContain('隐私政策')
    expect(template).toContain('使用条款')
    expect(template).toContain('问题反馈')
    expect(template).toContain('onboardingConsent')
    expect(template).toContain('v-if="!onboarding" class="section role-section"')
    expect(template).toContain('v-if="!onboarding" class="advanced-settings"')
  })
})
