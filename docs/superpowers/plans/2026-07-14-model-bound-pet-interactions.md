# Model-Bound Pet Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the hover shadow, make left-dragging the rendered Live2D model move the Electron window, and show a native settings/emotion/action menu only when the model is right-clicked.

**Architecture:** A renderer-side bounds helper converts Pixi world bounds to CSS client coordinates. The renderer uses those bounds for model-only drag and context-menu commands, while the main process owns window movement, mouse pass-through policy, and the native menu. Shared TypeScript contracts constrain IPC payloads and keep external adapter IDs from becoming arbitrary native menu data.

**Tech Stack:** Electron 34, Vue 3, TypeScript 5, PixiJS 6, pixi-live2d-display, Vitest 2, jsdom 25

---

## File Map

**Create:**

- `deskpet-app/vitest.config.ts`: Vitest configuration and `@` alias.
- `deskpet-app/src/renderer/services/live2d/model-bounds.ts`: Pixi-to-client bounds conversion and point hit testing.
- `deskpet-app/src/renderer/services/live2d/model-bounds.test.ts`: bounds conversion and inclusive edge tests.
- `deskpet-app/src/main/mouse-event-policy.ts`: pure click-through decision.
- `deskpet-app/src/main/mouse-event-policy.test.ts`: click-through truth table.
- `deskpet-app/src/renderer/composables/useWindowDrag.test.ts`: drag threshold, deltas, and cleanup tests.
- `deskpet-app/src/shared/pet-context-menu.ts`: validated menu request/command contracts and labels.
- `deskpet-app/src/shared/pet-context-menu.test.ts`: validation, deduplication, limits, and command guards.
- `deskpet-app/src/main/pet-context-menu.ts`: native menu template builder.
- `deskpet-app/src/main/pet-context-menu.test.ts`: settings, emotion, action, and empty-submenu tests.

**Modify:**

- `deskpet-app/package.json`: test scripts and dev dependencies.
- `deskpet-app/package-lock.json`: locked Vitest/jsdom dependencies.
- `deskpet-app/tsconfig.json`: scope renderer type checking and align the `@` alias with Vite.
- `deskpet-app/tsconfig.node.json`: include shared main/preload contracts.
- `deskpet-app/src/renderer/composables/useWindowDrag.ts`: rename the handler and inject the IPC callback for testing.
- `deskpet-app/src/main/index.ts`: mouse pass-through state and native context-menu IPC.
- `deskpet-app/src/preload/index.ts`: narrow context-menu and hit-test APIs.
- `deskpet-app/src/renderer/env.d.ts`: renderer-facing Electron API types.
- `deskpet-app/src/renderer/components/DeskpetStage.vue`: bounds-based interactions, command handling, and shadow removal.

**Delete:**

- `deskpet-app/src/renderer/composables/useModelDrag.ts`: obsolete in-canvas model dragging.

## Task 1: Add the Test Harness and Model Bounds Helper

**Files:**

- Create: `deskpet-app/vitest.config.ts`
- Create: `deskpet-app/src/renderer/services/live2d/model-bounds.ts`
- Create: `deskpet-app/src/renderer/services/live2d/model-bounds.test.ts`
- Modify: `deskpet-app/package.json`
- Modify: `deskpet-app/package-lock.json`

- [ ] **Step 1: Stop the running development process before changing dependencies**

Send `Ctrl-C` to the existing `npm run dev` session and confirm port 5173 is no longer listening:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

Expected: no listener output.

- [ ] **Step 2: Install the exact test dependencies**

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install --save-dev vitest@2.1.9 jsdom@25.0.1
```

Expected: `package.json` and `package-lock.json` change; Electron remains installed.

- [ ] **Step 3: Add test scripts and Vitest configuration**

Add these scripts to `package.json`:

```json
{
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Create `vitest.config.ts`:

```ts
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    clearMocks: true,
    restoreMocks: true,
    include: ['src/**/*.test.ts'],
  },
})
```

Update `tsconfig.json` so renderer type checking does not also consume the composite main/preload project, and so `@` matches `electron.vite.config.js`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "jsxImportSource": "vue",
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/renderer/*"]
    }
  },
  "include": [
    "src/renderer/**/*.ts",
    "src/renderer/**/*.d.ts",
    "src/renderer/**/*.vue",
    "src/shared/**/*.ts"
  ]
}
```

- [ ] **Step 4: Write the failing model-bounds tests**

Create `src/renderer/services/live2d/model-bounds.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isClientPointInsideModel, modelBoundsToClientBounds } from './model-bounds'

function canvasStub() {
  return {
    width: 1200,
    height: 1600,
    getBoundingClientRect: () => ({
      left: 20,
      top: 30,
      width: 600,
      height: 800,
    }),
  }
}

describe('modelBoundsToClientBounds', () => {
  it('converts Pixi renderer coordinates into CSS client coordinates', () => {
    const result = modelBoundsToClientBounds(
      { x: 200, y: 300, width: 400, height: 800 },
      canvasStub(),
    )

    expect(result).toEqual({ x: 120, y: 180, width: 200, height: 400 })
  })

  it('treats every model boundary edge as interactive', () => {
    const bounds = { x: 200, y: 300, width: 400, height: 800 }
    const canvas = canvasStub()

    expect(isClientPointInsideModel(bounds, canvas, 120, 180)).toBe(true)
    expect(isClientPointInsideModel(bounds, canvas, 320, 580)).toBe(true)
    expect(isClientPointInsideModel(bounds, canvas, 119.9, 180)).toBe(false)
    expect(isClientPointInsideModel(bounds, canvas, 320.1, 580)).toBe(false)
  })
})
```

- [ ] **Step 5: Run the focused test and verify the red state**

```bash
npm test -- src/renderer/services/live2d/model-bounds.test.ts
```

Expected: FAIL because `./model-bounds` does not exist.

- [ ] **Step 6: Implement the minimal bounds helper**

Create `src/renderer/services/live2d/model-bounds.ts`:

```ts
export interface BoundsLike {
  x: number
  y: number
  width: number
  height: number
}

export interface CanvasLike {
  width: number
  height: number
  getBoundingClientRect(): {
    left: number
    top: number
    width: number
    height: number
  }
}

export function modelBoundsToClientBounds(
  bounds: BoundsLike,
  canvas: CanvasLike,
): BoundsLike {
  const rect = canvas.getBoundingClientRect()
  const scaleX = rect.width / canvas.width
  const scaleY = rect.height / canvas.height

  return {
    x: rect.left + bounds.x * scaleX,
    y: rect.top + bounds.y * scaleY,
    width: bounds.width * scaleX,
    height: bounds.height * scaleY,
  }
}

export function isClientPointInsideModel(
  bounds: BoundsLike,
  canvas: CanvasLike,
  clientX: number,
  clientY: number,
): boolean {
  const clientBounds = modelBoundsToClientBounds(bounds, canvas)
  return clientX >= clientBounds.x
    && clientX <= clientBounds.x + clientBounds.width
    && clientY >= clientBounds.y
    && clientY <= clientBounds.y + clientBounds.height
}
```

- [ ] **Step 7: Run the focused test and type checker**

```bash
npm test -- src/renderer/services/live2d/model-bounds.test.ts
npx vue-tsc --noEmit
npx tsc --noEmit -p tsconfig.node.json
```

Expected: 2 tests PASS; renderer and Node type checking both exit 0.

- [ ] **Step 8: Commit the bounds helper**

```bash
git add deskpet-app/package.json deskpet-app/package-lock.json deskpet-app/tsconfig.json deskpet-app/vitest.config.ts deskpet-app/src/renderer/services/live2d/model-bounds.ts deskpet-app/src/renderer/services/live2d/model-bounds.test.ts
git commit -m "test: add model bounds interaction helper"
```

## Task 2: Make Window Dragging and Mouse Pass-Through Testable

**Files:**

- Create: `deskpet-app/src/main/mouse-event-policy.ts`
- Create: `deskpet-app/src/main/mouse-event-policy.test.ts`
- Create: `deskpet-app/src/renderer/composables/useWindowDrag.test.ts`
- Modify: `deskpet-app/src/renderer/composables/useWindowDrag.ts`
- Modify: `deskpet-app/src/main/index.ts`
- Modify: `deskpet-app/src/preload/index.ts`
- Modify: `deskpet-app/src/renderer/env.d.ts`

- [ ] **Step 1: Write the failing mouse-policy and window-drag tests**

Create `src/main/mouse-event-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { shouldIgnoreMouseEvents } from './mouse-event-policy'

describe('shouldIgnoreMouseEvents', () => {
  it.each([
    [{ clickThroughLocked: false, pointerInteractive: true }, false],
    [{ clickThroughLocked: false, pointerInteractive: false }, true],
    [{ clickThroughLocked: true, pointerInteractive: true }, true],
    [{ clickThroughLocked: true, pointerInteractive: false }, true],
  ])('resolves %o to %s', (state, expected) => {
    expect(shouldIgnoreMouseEvents(state)).toBe(expected)
  })
})
```

Create `src/renderer/composables/useWindowDrag.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { useWindowDrag } from './useWindowDrag'

function mouseEvent(type: string, screenX: number, screenY: number): MouseEvent {
  const event = new MouseEvent(type)
  Object.defineProperties(event, {
    screenX: { value: screenX },
    screenY: { value: screenY },
  })
  return event
}

describe('useWindowDrag', () => {
  it('waits for the threshold, reports deltas, and stops after mouseup', () => {
    const dragWindow = vi.fn()
    const { onWindowMouseDown } = useWindowDrag(dragWindow)

    onWindowMouseDown(mouseEvent('mousedown', 100, 100))
    document.dispatchEvent(mouseEvent('mousemove', 102, 102))
    expect(dragWindow).not.toHaveBeenCalled()

    document.dispatchEvent(mouseEvent('mousemove', 108, 111))
    expect(dragWindow).toHaveBeenLastCalledWith(8, 11)

    document.dispatchEvent(mouseEvent('mousemove', 110, 115))
    expect(dragWindow).toHaveBeenLastCalledWith(2, 4)

    document.dispatchEvent(mouseEvent('mouseup', 110, 115))
    document.dispatchEvent(mouseEvent('mousemove', 120, 125))
    expect(dragWindow).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run both tests and verify the red state**

```bash
npm test -- src/main/mouse-event-policy.test.ts src/renderer/composables/useWindowDrag.test.ts
```

Expected: FAIL because `mouse-event-policy.ts` and `onWindowMouseDown` do not exist.

- [ ] **Step 3: Implement the pure mouse policy**

Create `src/main/mouse-event-policy.ts`:

```ts
export interface MouseEventPolicyState {
  clickThroughLocked: boolean
  pointerInteractive: boolean
}

export function shouldIgnoreMouseEvents(state: MouseEventPolicyState): boolean {
  return state.clickThroughLocked || !state.pointerInteractive
}
```

- [ ] **Step 4: Refactor the window drag composable without changing its threshold**

Replace `useWindowDrag.ts` with:

```ts
export type DragWindow = (dx: number, dy: number) => unknown

export function useWindowDrag(
  dragWindow: DragWindow = (dx, dy) => window.electronAPI?.dragWindow(dx, dy),
) {
  function onWindowMouseDown(e: MouseEvent) {
    let lastX = e.screenX
    let lastY = e.screenY
    let moved = false

    const onMove = (ev: MouseEvent) => {
      const dx = ev.screenX - lastX
      const dy = ev.screenY - lastY
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
      moved = true
      void dragWindow(dx, dy)
      lastX = ev.screenX
      lastY = ev.screenY
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return { onWindowMouseDown }
}
```

- [ ] **Step 5: Apply the policy in the main process**

Import the helper in `src/main/index.ts`:

```ts
import { shouldIgnoreMouseEvents } from './mouse-event-policy'
```

Add the state and application function next to `clickThroughLocked`:

```ts
let clickThroughLocked = false
let pointerInteractive = true

function applyMouseEventPolicy(): void {
  const ignore = shouldIgnoreMouseEvents({ clickThroughLocked, pointerInteractive })
  mainWindow?.setIgnoreMouseEvents(ignore, { forward: true })
}
```

Change `setClickThroughLocked` to call `applyMouseEventPolicy()` instead of calling `setIgnoreMouseEvents` directly. Set `pointerInteractive = true` at the start of `createWindow`, call `applyMouseEventPolicy()` after `mainWindow` is created, and replace the old direct `setIgnoreMouseEvents` call.

Register this IPC handler beside `drag-window`:

```ts
ipcMain.handle('set-pet-hit-test-interactive', (event, interactive: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win !== mainWindow || typeof interactive !== 'boolean') return
  pointerInteractive = interactive
  applyMouseEventPolicy()
})
```

- [ ] **Step 6: Expose the narrow hit-test API**

Add to `src/preload/index.ts`:

```ts
setPetHitTestInteractive: (interactive: boolean) =>
  ipcRenderer.invoke('set-pet-hit-test-interactive', interactive),
```

Add to `ElectronAPI` in `src/renderer/env.d.ts`:

```ts
setPetHitTestInteractive: (interactive: boolean) => Promise<void>
```

- [ ] **Step 7: Run tests, type checking, and build**

```bash
npm test -- src/main/mouse-event-policy.test.ts src/renderer/composables/useWindowDrag.test.ts
npx vue-tsc --noEmit
npx tsc --noEmit -p tsconfig.node.json
npm run build
```

Expected: 5 tests PASS; type checking and build exit 0.

- [ ] **Step 8: Commit the drag and policy layer**

```bash
git add deskpet-app/src/main/mouse-event-policy.ts deskpet-app/src/main/mouse-event-policy.test.ts deskpet-app/src/renderer/composables/useWindowDrag.ts deskpet-app/src/renderer/composables/useWindowDrag.test.ts deskpet-app/src/main/index.ts deskpet-app/src/preload/index.ts deskpet-app/src/renderer/env.d.ts
git commit -m "feat: add model-aware window interaction policy"
```

## Task 3: Define and Test the Native Pet Menu

**Files:**

- Create: `deskpet-app/src/shared/pet-context-menu.ts`
- Create: `deskpet-app/src/shared/pet-context-menu.test.ts`
- Create: `deskpet-app/src/main/pet-context-menu.ts`
- Create: `deskpet-app/src/main/pet-context-menu.test.ts`
- Modify: `deskpet-app/tsconfig.node.json`

- [ ] **Step 1: Write the failing shared contract tests**

Create `src/shared/pet-context-menu.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  formatPetMenuLabel,
  isPetContextMenuCommand,
  normalizePetContextMenuRequest,
} from './pet-context-menu'

describe('normalizePetContextMenuRequest', () => {
  it('trims, validates, deduplicates, and limits IDs', () => {
    const actions = Array.from({ length: 40 }, (_, index) => `action-${index}`)
    const result = normalizePetContextMenuRequest({
      emotions: [' happy ', 'happy', '../bad', 12],
      actions,
    })

    expect(result.emotions).toEqual(['happy'])
    expect(result.actions).toHaveLength(32)
    expect(result.actions[0]).toBe('action-0')
  })
})

describe('pet context menu commands', () => {
  it('accepts only known command shapes', () => {
    expect(isPetContextMenuCommand({ type: 'settings' })).toBe(true)
    expect(isPetContextMenuCommand({ type: 'emotion', id: 'happy' })).toBe(true)
    expect(isPetContextMenuCommand({ type: 'action', id: 'jump' })).toBe(true)
    expect(isPetContextMenuCommand({ type: 'action', id: '../bad' })).toBe(false)
    expect(isPetContextMenuCommand({ type: 'other' })).toBe(false)
  })

  it('uses Chinese labels for known IDs and raw IDs for extensions', () => {
    expect(formatPetMenuLabel('happy', 'emotion')).toBe('开心')
    expect(formatPetMenuLabel('jump', 'action')).toBe('跳跃')
    expect(formatPetMenuLabel('hiyori:wave', 'action')).toBe('hiyori:wave')
  })
})
```

- [ ] **Step 2: Write the failing native template tests**

Create `src/main/pet-context-menu.test.ts`:

```ts
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
    expect(submenu(template[2])[0]).toMatchObject({ enabled: false })
    expect(submenu(template[3])[0]).toMatchObject({ enabled: false })
  })
})
```

- [ ] **Step 3: Run focused tests and verify the red state**

```bash
npm test -- src/shared/pet-context-menu.test.ts src/main/pet-context-menu.test.ts
```

Expected: FAIL because both implementation files do not exist.

- [ ] **Step 4: Implement the validated shared contract**

Create `src/shared/pet-context-menu.ts`:

```ts
const MAX_MENU_ITEMS = 32
const MENU_ID = /^[A-Za-z0-9:_-]{1,64}$/

export interface PetContextMenuRequest {
  emotions: string[]
  actions: string[]
}

export type PetContextMenuCommand =
  | { type: 'settings' }
  | { type: 'emotion'; id: string }
  | { type: 'action'; id: string }

const EMOTION_LABELS: Record<string, string> = {
  happy: '开心',
  sad: '难过',
  angry: '生气',
  surprise: '惊讶',
  thinking: '思考',
  shy: '害羞',
  curious: '好奇',
  neutral: '默认',
  idle: '放松',
}

const ACTION_LABELS: Record<string, string> = {
  wave: '挥手',
  jump: '跳跃',
  spin: '旋转',
  sit: '坐下',
  sleep: '睡觉',
  wake: '醒来',
  dance: '跳舞',
  cheer: '欢呼',
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()

  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (!MENU_ID.test(id) || seen.has(id)) continue
    seen.add(id)
    result.push(id)
    if (result.length === MAX_MENU_ITEMS) break
  }
  return result
}

export function normalizePetContextMenuRequest(value: unknown): PetContextMenuRequest {
  const input = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  return {
    emotions: normalizeIds(input.emotions),
    actions: normalizeIds(input.actions),
  }
}

export function isPetContextMenuCommand(value: unknown): value is PetContextMenuCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Record<string, unknown>
  if (command.type === 'settings') return true
  if (command.type !== 'emotion' && command.type !== 'action') return false
  return typeof command.id === 'string' && MENU_ID.test(command.id)
}

export function formatPetMenuLabel(id: string, kind: 'emotion' | 'action'): string {
  return (kind === 'emotion' ? EMOTION_LABELS : ACTION_LABELS)[id] || id
}
```

- [ ] **Step 5: Implement the native menu template builder**

Create `src/main/pet-context-menu.ts`:

```ts
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
    { type: 'separator' },
    { label: '表情', submenu: capabilityItems(request.emotions, 'emotion', emit) },
    { label: '动作', submenu: capabilityItems(request.actions, 'action', emit) },
  ]
}
```

- [ ] **Step 6: Include shared contracts in the Node TypeScript project**

Change `tsconfig.node.json` `include` to:

```json
{
  "include": [
    "electron-vite.config.ts",
    "src/main/**/*.ts",
    "src/preload/**/*.ts",
    "src/shared/**/*.ts"
  ]
}
```

- [ ] **Step 7: Run focused tests and type checking**

```bash
npm test -- src/shared/pet-context-menu.test.ts src/main/pet-context-menu.test.ts
npx vue-tsc --noEmit
npx tsc --noEmit -p tsconfig.node.json
```

Expected: 5 tests PASS; renderer and Node type checking both exit 0.

- [ ] **Step 8: Commit the native menu contract**

```bash
git add deskpet-app/src/shared/pet-context-menu.ts deskpet-app/src/shared/pet-context-menu.test.ts deskpet-app/src/main/pet-context-menu.ts deskpet-app/src/main/pet-context-menu.test.ts deskpet-app/tsconfig.node.json
git commit -m "feat: define native pet context menu"
```

## Task 4: Wire the Native Menu Through Main and Preload

**Files:**

- Modify: `deskpet-app/src/main/index.ts`
- Modify: `deskpet-app/src/preload/index.ts`
- Modify: `deskpet-app/src/renderer/env.d.ts`

- [ ] **Step 1: Add shared imports**

Add to `src/main/index.ts`:

```ts
import { buildPetContextMenuTemplate } from './pet-context-menu'
```

Add to `src/preload/index.ts`:

```ts
import {
  isPetContextMenuCommand,
  type PetContextMenuCommand,
  type PetContextMenuRequest,
} from '../shared/pet-context-menu'
```

- [ ] **Step 2: Register native-menu IPC in the main process**

Register next to `drag-window`:

```ts
ipcMain.handle('show-pet-context-menu', (event, request: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win !== mainWindow) return

  const template = buildPetContextMenuTemplate(request, (command) => {
    win.webContents.send('pet-context-command', command)
  })
  Menu.buildFromTemplate(template).popup({ window: win })
})
```

- [ ] **Step 3: Expose request and subscription methods from preload**

Add inside `contextBridge.exposeInMainWorld`:

```ts
showPetContextMenu: (request: PetContextMenuRequest) =>
  ipcRenderer.invoke('show-pet-context-menu', request),
onPetContextMenuCommand: (callback: (command: PetContextMenuCommand) => void) => {
  const listener = (_event: Electron.IpcRendererEvent, command: unknown) => {
    if (isPetContextMenuCommand(command)) callback(command)
  }
  ipcRenderer.on('pet-context-command', listener)
  return () => ipcRenderer.removeListener('pet-context-command', listener)
},
```

- [ ] **Step 4: Add renderer API types**

Add to `ElectronAPI` in `src/renderer/env.d.ts`:

```ts
showPetContextMenu: (
  request: import('../shared/pet-context-menu').PetContextMenuRequest,
) => Promise<void>
onPetContextMenuCommand: (
  callback: (command: import('../shared/pet-context-menu').PetContextMenuCommand) => void,
) => () => void
```

- [ ] **Step 5: Run all tests, type checking, and build**

```bash
npm test
npx vue-tsc --noEmit
npx tsc --noEmit -p tsconfig.node.json
npm run build
```

Expected: all tests PASS; type checking and all three electron-vite bundles exit 0.

- [ ] **Step 6: Commit the IPC wiring**

```bash
git add deskpet-app/src/main/index.ts deskpet-app/src/preload/index.ts deskpet-app/src/renderer/env.d.ts
git commit -m "feat: wire pet context menu IPC"
```

## Task 5: Integrate Model-Bound Interactions in DeskpetStage

**Files:**

- Modify: `deskpet-app/src/renderer/components/DeskpetStage.vue`
- Delete: `deskpet-app/src/renderer/composables/useModelDrag.ts`

- [ ] **Step 1: Replace the stage interaction bindings and mark visible UI**

Replace the corresponding template region with this complete structure:

```vue
<div
  class="deskpet-stage"
  :class="{ hovered: isHovered, 'hover-fade-enabled': store.hoverFadeEnabled }"
  @dblclick="onDoubleClick"
  @mousedown.left="onPetMouseDown"
  @contextmenu="onPetContextMenu"
  @mouseenter="isHovered = true"
  @mouseleave="isHovered = false"
>
  <div ref="stageRef" class="live2d-stage" />
  <div
    class="nav-bar"
    data-pet-ui
    title="拖动窗口，双击重置模型位置和缩放"
    @mousedown.stop="onWindowMouseDown"
    @dblclick.stop="resetModelView"
  />

  <div class="btn-bar" data-pet-ui :class="{ shifted: chatPanelOpen }">
    <div class="btn-bar-item" @mousedown.stop @click.stop="showSettings = true" title="设置">⚙</div>
    <div class="btn-bar-item" @mousedown.stop @click.stop="chatPanelOpen = !chatPanelOpen" :title="chatPanelOpen ? '收起聊天' : '聊天记录'">💬</div>
    <div class="btn-bar-item" :class="{ recording: recordingActive, vad: vadActive }" @mousedown.stop @click.stop="toggleRecording" :title="vadActive ? 'VAD 监听中，点击关闭' : (recordingActive ? '停止录音' : '语音输入')">🎤</div>
  </div>

  <SettingsPanel data-pet-ui :open="showSettings" @close="showSettings = false" />

  <ChatBubble
    data-pet-ui
    :messages="chatStore.messages"
    :last-bubble="chatStore.chatBubble"
    :panel-open="chatPanelOpen"
    @bubbles-cleared="showInput = false; inputText = ''"
  />

  <QuickInput
    v-model="inputText"
    data-pet-ui
    :visible="showInput"
    @submit="sendText"
    @blur="showInput = false"
  />
</div>
```

Keep the existing `modelError` block between `SettingsPanel` and `ChatBubble`; add `data-pet-ui` to its root so diagnostics stay interactive:

```vue
<div v-if="modelError" class="model-error" data-pet-ui>
```

- [ ] **Step 2: Replace model-drag imports with bounds and command imports**

Remove:

```ts
import { useModelDrag } from '@/composables/useModelDrag'
```

Remove `modelRefW` and `modelRefH` from the loader import. Add:

```ts
import { isClientPointInsideModel } from '@/services/live2d/model-bounds'
import type { PetContextMenuCommand } from '../../shared/pet-context-menu'
```

Rename the window-drag binding and remove the model-drag binding:

```ts
const { onWindowMouseDown } = useWindowDrag()
```

Delete:

```ts
const { onModelMouseDown, consumeDragOffsets } = useModelDrag()
```

- [ ] **Step 3: Add bounds, UI, and command handlers**

Add near component state and helper functions:

```ts
let unsubscribePetContextCommand: (() => void) | null = null
let lastPointerInteractive: boolean | null = null

function isUiTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-pet-ui]'))
}

function isPointOverModel(clientX: number, clientY: number): boolean {
  const model = store.live2dModel
  const canvas = store.pixiApp?.view as HTMLCanvasElement | undefined
  if (!model || !canvas) return false
  return isClientPointInsideModel(model.getBounds(), canvas, clientX, clientY)
}

function isPointOverVisibleUi(clientX: number, clientY: number): boolean {
  const target = document.elementFromPoint(clientX, clientY)
  return Boolean(target?.closest('[data-pet-ui]'))
}

function syncPointerInteractive(clientX: number, clientY: number): void {
  const interactive = isPointOverModel(clientX, clientY)
    || isPointOverVisibleUi(clientX, clientY)
  if (interactive === lastPointerInteractive) return
  lastPointerInteractive = interactive
  void window.electronAPI?.setPetHitTestInteractive(interactive)
}

function onPetMouseDown(event: MouseEvent): void {
  if (isUiTarget(event.target) || !isPointOverModel(event.clientX, event.clientY)) return
  event.preventDefault()
  onWindowMouseDown(event)
}

function onPetContextMenu(event: MouseEvent): void {
  if (isUiTarget(event.target) || !isPointOverModel(event.clientX, event.clientY)) return
  event.preventDefault()
  const adapter = store.emotionAdapter
  void window.electronAPI?.showPetContextMenu({
    emotions: Object.keys(adapter?.emotions ?? {}),
    actions: Object.keys(adapter?.animations ?? {}),
  })
}

function handlePetContextCommand(command: PetContextMenuCommand): void {
  if (command.type === 'settings') {
    showSettings.value = true
    return
  }
  if (command.type === 'emotion') {
    if (getEmotionTarget(store.emotionAdapter, command.id)) {
      store.currentEmotion = command.id
    }
    return
  }
  if (getAnimationTarget(store.emotionAdapter, command.id)) {
    store.pendingAnimation = command.id
    store.pendingAnimationLoop = false
  }
}
```

- [ ] **Step 4: Subscribe before model loading and update hit testing from cursor data**

At the start of `onMounted`, before any early return:

```ts
unsubscribePetContextCommand = window.electronAPI?.onPetContextMenuCommand(
  handlePetContextCommand,
) ?? null
```

Extend the existing global cursor callback:

```ts
unsubscribeGlobalCursor = window.electronAPI?.onGlobalCursorPosition?.((position) => {
  mouseX = position.x
  mouseY = position.y
  syncPointerInteractive(position.x, position.y)
}) ?? null
```

After `mouseX` and `mouseY` are declared, add:

```ts
watch([showSettings, chatPanelOpen, showInput], () => {
  syncPointerInteractive(mouseX, mouseY)
})
```

- [ ] **Step 5: Remove obsolete in-canvas dragging**

Delete the complete `consumeDragOffsets()` block from `startAnimationPoll`. Do not remove persisted zoom/offset loading or reset behavior; pointer dragging must stop changing those offsets.

Delete the now-unused file with `apply_patch`:

```text
*** Begin Patch
*** Delete File: deskpet-app/src/renderer/composables/useModelDrag.ts
*** End Patch
```

- [ ] **Step 6: Add cleanup for the menu subscription and pointer policy**

In the existing `onUnmounted` cleanup add:

```ts
unsubscribePetContextCommand?.()
unsubscribePetContextCommand = null
void window.electronAPI?.setPetHitTestInteractive(true)
```

- [ ] **Step 7: Remove only the hover shadow CSS**

Delete the entire `.deskpet-stage::after` and `.deskpet-stage.hovered::after` rules. Keep the fade rules unchanged:

```css
.live2d-stage {
  width: 100%;
  height: 100%;
  display: block;
  transition: opacity 0.18s ease;
}

.deskpet-stage.hover-fade-enabled.hovered .live2d-stage {
  opacity: 0.15;
}
```

- [ ] **Step 8: Run tests, type checking, and build**

```bash
npm test
npx vue-tsc --noEmit
npx tsc --noEmit -p tsconfig.node.json
npm run build
```

Expected: all tests PASS; type checking and build exit 0. The existing warning about the non-module Cubism Core script may remain, but there must be no errors.

- [ ] **Step 9: Commit the renderer integration**

```bash
git add deskpet-app/src/renderer/components/DeskpetStage.vue deskpet-app/src/renderer/composables/useModelDrag.ts
git commit -m "feat: add model-bound pet interactions"
```

## Task 6: Run Visual and Electron Interaction Verification

**Files:**

- No source files expected.

- [ ] **Step 1: Start the development app**

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dev
```

Expected: renderer listens on `http://localhost:5173/` and an Electron pet window opens.

- [ ] **Step 2: Verify the renderer visually**

Open `http://localhost:5173/` in the in-app browser and evaluate:

```js
const stage = document.querySelector('.deskpet-stage')
const afterStyle = getComputedStyle(stage, '::after')
({
  canvasCount: document.querySelectorAll('canvas').length,
  modelError: document.querySelector('.model-error')?.textContent || null,
  hoverShadow: afterStyle.boxShadow,
})
```

Expected:

- `canvasCount` is 1.
- `modelError` is `null`.
- `hoverShadow` is `none`.
- A screenshot shows Hiyori with no dark rectangular inset shadow.

- [ ] **Step 3: Verify actual Electron interactions on macOS**

Perform this focused matrix in the Electron window:

1. Drag inside the character bounds: the BrowserWindow moves and the model keeps the same internal offset.
2. Drag in a transparent corner: the window does not move and the underlying desktop receives the pointer.
3. Right-click the character: the native menu shows 设置、表情、动作.
4. Select 设置: the existing settings panel opens.
5. Select 开心: the mapped happy expression plays and follows the existing expression timer.
6. Select 跳跃: the mapped jump motion plays through the existing pending-animation flow.
7. Click the gear, chat, microphone, bottom drag bar, settings panel, and quick input: each remains interactive.
8. Enable 悬停淡化模型 from the tray: the model fades on hover, but no shadow appears.

Expected: all eight checks pass without renderer or main-process errors.

- [ ] **Step 4: Run the final verification suite from a fresh command**

```bash
npm test
npx vue-tsc --noEmit
npx tsc --noEmit -p tsconfig.node.json
npm run build
git diff --check
git status --short --branch
```

Expected:

- All tests PASS.
- Type checking and build exit 0.
- `git diff --check` prints nothing.
- `git status` shows no uncommitted source changes.
- The development process remains running for user review.
