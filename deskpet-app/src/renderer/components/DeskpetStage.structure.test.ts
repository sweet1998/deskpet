// @vitest-environment node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { baseParse } from '@vue/compiler-dom'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

function collectTemplateShape(source: string) {
  const { descriptor } = parse(source)
  const template = descriptor.template?.content ?? ''
  const ast = baseParse(template)
  const tags: string[] = []
  const classes: string[] = []
  const events: string[] = []

  function visit(node: any): void {
    if (node.type === 1) {
      tags.push(node.tag)
      for (const prop of node.props) {
        if (prop.type === 6 && prop.name === 'class' && prop.value) {
          classes.push(...prop.value.content.split(/\s+/))
        }
        if (prop.type === 7 && prop.name === 'on' && prop.arg?.type === 4) {
          events.push(prop.arg.content)
        }
      }
    }
    for (const child of node.children ?? []) visit(child)
  }

  visit(ast)
  return {
    tags,
    classes,
    events,
    template,
    scriptSetup: descriptor.scriptSetup?.content ?? '',
  }
}

describe('DeskpetStage model-only shell', () => {
  it('mounts no persistent UI outside the model', () => {
    const filename = fileURLToPath(new URL('./DeskpetStage.vue', import.meta.url))
    const shape = collectTemplateShape(readFileSync(filename, 'utf8'))

    expect(shape.tags).toContain('SettingsPanel')
    expect(shape.tags).not.toContain('ChatBubble')
    expect(shape.tags).not.toContain('QuickInput')
    expect(shape.classes).not.toContain('nav-bar')
    expect(shape.classes).not.toContain('btn-bar')
    expect(shape.events).not.toContain('dblclick')
    expect(shape.template).not.toContain('⚙')
    expect(shape.template).not.toContain('💬')
    expect(shape.template).not.toContain('🎤')
    expect(shape.scriptSetup).not.toContain('modelOffsetX')
    expect(shape.scriptSetup).not.toContain('modelOffsetY')
  })
})
