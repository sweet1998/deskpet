import type { MenuItemConstructorOptions } from 'electron'
import {
  formatPetMenuLabel,
  normalizePetContextMenuRequest,
  type PetContextMenuCommand,
} from '../shared/pet-context-menu'

function capabilityItems(
  ids: string[],
  kind: 'emotion' | 'action',
  emit: (command: PetContextMenuCommand) => void,
): MenuItemConstructorOptions[] {
  if (ids.length === 0) {
    return [{ label: '当前模型没有可用项目', enabled: false }]
  }

  return ids.map((id) => ({
    label: formatPetMenuLabel(id, kind),
    click: () => {
      if (kind === 'emotion') emit({ type: 'emotion', id })
      else emit({ type: 'action', id })
    },
  }))
}

export function buildPetContextMenuTemplate(
  input: unknown,
  emit: (command: PetContextMenuCommand) => void,
): MenuItemConstructorOptions[] {
  const request = normalizePetContextMenuRequest(input)

  return [
    { label: '设置...', click: () => emit({ type: 'settings' }) },
    {
      label: `角色：${request.currentRole === 'stock_expert' ? '炒股专家' : '麦麦'}`,
      submenu: [
        {
          label: '麦麦',
          type: 'radio',
          checked: request.currentRole === 'default',
          click: () => emit({ type: 'role', id: 'default' }),
        },
        {
          label: '炒股专家',
          type: 'radio',
          checked: request.currentRole === 'stock_expert',
          click: () => emit({ type: 'role', id: 'stock_expert' }),
        },
      ],
    },
    { type: 'separator' },
    { label: '表情', submenu: capabilityItems(request.emotions, 'emotion', emit) },
    { label: '动作', submenu: capabilityItems(request.actions, 'action', emit) },
  ]
}
