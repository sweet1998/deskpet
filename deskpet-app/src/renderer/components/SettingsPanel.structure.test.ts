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
    expect(template).toContain('富途 OpenD 行情')
    expect(template).toContain('测试连接')
  })
})
