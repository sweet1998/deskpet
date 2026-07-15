import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { buildPetContextMenuTemplate } from './pet-context-menu'

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[]
}

describe('buildPetContextMenuTemplate', () => {
  it('emits settings, emotion, and action commands', () => {
    const emit = vi.fn()
    const template = buildPetContextMenuTemplate(
      { emotions: ['happy'], actions: ['jump'] },
      emit,
    )

    ;(template[0].click as () => void)()
    ;(submenu(template[2])[0].click as () => void)()
    ;(submenu(template[3])[0].click as () => void)()

    expect(emit.mock.calls).toEqual([
      [{ type: 'settings' }],
      [{ type: 'emotion', id: 'happy' }],
      [{ type: 'action', id: 'jump' }],
    ])
  })

  it('shows disabled placeholders for empty capabilities', () => {
    const template = buildPetContextMenuTemplate({}, vi.fn())
    const placeholder = {
      label: '当前模型没有可用项目',
      enabled: false,
    }

    expect(submenu(template[2])[0]).toMatchObject(placeholder)
    expect(submenu(template[3])[0]).toMatchObject(placeholder)
  })
})
