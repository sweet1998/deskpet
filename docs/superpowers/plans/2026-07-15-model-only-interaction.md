# 仅人物区域交互实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除透明桌宠窗口中的所有常驻控件，使常态下只有 Live2D 人物 bounds 可接收鼠标，同时保留人物右键菜单和主动打开的设置面板。

**Architecture:** renderer 使用纯策略函数组合“拖拽中、人物命中、设置已打开、设置面板命中”四个状态，决定整个 BrowserWindow 是否接收鼠标。`DeskpetStage` 只挂载模型、设置面板和错误文字；旧聊天、语音和快捷输入组件保留在代码库，但不再挂载到透明窗口。模型视图状态在读取时迁移旧 offset 为零，保证升级后人物仍位于窗口内。

**Tech Stack:** Electron 34、Vue 3、TypeScript 5、Pinia 2、PixiJS 6、Vitest 2、jsdom 25

---

## 文件映射

**创建：**

- `deskpet-app/src/renderer/services/interaction/pet-window-policy.ts`：纯窗口命中决策。
- `deskpet-app/src/renderer/services/interaction/pet-window-policy.test.ts`：人物内外、拖拽和设置例外测试。
- `deskpet-app/src/renderer/stores/model-view-state.ts`：旧模型视图状态迁移。
- `deskpet-app/src/renderer/stores/model-view-state.test.ts`：旧 offset 清零和 zoom 保留测试。
- `deskpet-app/src/renderer/components/DeskpetStage.structure.test.ts`：SFC 模板结构回归测试。

**修改：**

- `deskpet-app/src/renderer/stores/deskpet.ts`：使用迁移后的模型视图状态并持久化零 offset。
- `deskpet-app/src/renderer/components/DeskpetStage.vue`：移除人物外 UI，接入纯策略，停止应用任何模型 offset。

**保留不删：**

- `ChatBubble.vue`、`QuickInput.vue`、`useVoiceInput.ts`：只从桌宠窗口卸载，供未来独立界面复用。
- `SettingsPanel.vue`：作为人物右键“设置”命令的临时交互例外。

## Task 1：定义仅人物窗口交互策略

**Files:**

- Create: `deskpet-app/src/renderer/services/interaction/pet-window-policy.ts`
- Create: `deskpet-app/src/renderer/services/interaction/pet-window-policy.test.ts`

- [ ] **Step 1：写失败的窗口策略测试**

创建 `src/renderer/services/interaction/pet-window-policy.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { shouldPetWindowBeInteractive } from './pet-window-policy'

describe('shouldPetWindowBeInteractive', () => {
  it.each([
    {
      name: 'accepts the rendered model',
      state: {
        dragActive: false,
        pointOverModel: true,
        settingsOpen: false,
        pointOverSettings: false,
      },
      expected: true,
    },
    {
      name: 'passes through normal transparent space',
      state: {
        dragActive: false,
        pointOverModel: false,
        settingsOpen: false,
        pointOverSettings: false,
      },
      expected: false,
    },
    {
      name: 'ignores a settings rectangle while settings are closed',
      state: {
        dragActive: false,
        pointOverModel: false,
        settingsOpen: false,
        pointOverSettings: true,
      },
      expected: false,
    },
    {
      name: 'accepts the visible settings panel after an explicit open command',
      state: {
        dragActive: false,
        pointOverModel: false,
        settingsOpen: true,
        pointOverSettings: true,
      },
      expected: true,
    },
    {
      name: 'keeps receiving the pointer for an active drag',
      state: {
        dragActive: true,
        pointOverModel: false,
        settingsOpen: false,
        pointOverSettings: false,
      },
      expected: true,
    },
  ])('$name', ({ state, expected }) => {
    expect(shouldPetWindowBeInteractive(state)).toBe(expected)
  })
})
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
cd deskpet-app
npm test -- src/renderer/services/interaction/pet-window-policy.test.ts
```

Expected: FAIL，因为 `./pet-window-policy` 尚不存在。

- [ ] **Step 3：实现最小纯策略**

创建 `src/renderer/services/interaction/pet-window-policy.ts`：

```ts
export interface PetWindowInteractionState {
  dragActive: boolean
  pointOverModel: boolean
  settingsOpen: boolean
  pointOverSettings: boolean
}

export function shouldPetWindowBeInteractive({
  dragActive,
  pointOverModel,
  settingsOpen,
  pointOverSettings,
}: PetWindowInteractionState): boolean {
  return dragActive || pointOverModel || (settingsOpen && pointOverSettings)
}
```

- [ ] **Step 4：运行 focused 测试并确认 GREEN**

Run:

```bash
npm test -- src/renderer/services/interaction/pet-window-policy.test.ts
```

Expected: 1 个测试文件、5 项测试通过。

- [ ] **Step 5：提交纯策略**

```bash
git add deskpet-app/src/renderer/services/interaction/pet-window-policy.ts deskpet-app/src/renderer/services/interaction/pet-window-policy.test.ts
git commit -m "test: define model-only window policy"
```

## Task 2：迁移旧模型 offset

**Files:**

- Create: `deskpet-app/src/renderer/stores/model-view-state.ts`
- Create: `deskpet-app/src/renderer/stores/model-view-state.test.ts`
- Modify: `deskpet-app/src/renderer/stores/deskpet.ts`

- [ ] **Step 1：写失败的迁移测试**

创建 `src/renderer/stores/model-view-state.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_VIEW_STATE,
  migratePersistedModelViewState,
} from './model-view-state'

describe('migratePersistedModelViewState', () => {
  it('preserves zoom and clears legacy model offsets', () => {
    expect(migratePersistedModelViewState({
      zoom: 1.25,
      offsetX: -543,
      offsetY: 80,
    })).toEqual({
      zoom: 1.25,
      offsetX: 0,
      offsetY: 0,
    })
  })

  it('uses defaults for invalid persisted input', () => {
    expect(migratePersistedModelViewState({ zoom: 'large' }))
      .toEqual(DEFAULT_MODEL_VIEW_STATE)
  })

  it('returns a new default object when no state exists', () => {
    const state = migratePersistedModelViewState(null)
    expect(state).toEqual(DEFAULT_MODEL_VIEW_STATE)
    expect(state).not.toBe(DEFAULT_MODEL_VIEW_STATE)
  })
})
```

- [ ] **Step 2：运行测试并确认 RED**

Run:

```bash
npm test -- src/renderer/stores/model-view-state.test.ts
```

Expected: FAIL，因为 `./model-view-state` 尚不存在。

- [ ] **Step 3：实现纯迁移函数**

创建 `src/renderer/stores/model-view-state.ts`：

```ts
export interface PersistedModelViewState {
  zoom: number
  offsetX: number
  offsetY: number
}

export const DEFAULT_MODEL_VIEW_STATE: PersistedModelViewState = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
}

export function migratePersistedModelViewState(value: unknown): PersistedModelViewState {
  const input = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  const zoom = typeof input.zoom === 'number' && Number.isFinite(input.zoom)
    ? input.zoom
    : DEFAULT_MODEL_VIEW_STATE.zoom

  return {
    zoom,
    offsetX: 0,
    offsetY: 0,
  }
}
```

- [ ] **Step 4：让 store 使用并持久化迁移结果**

在 `src/renderer/stores/deskpet.ts` 导入：

```ts
import {
  DEFAULT_MODEL_VIEW_STATE,
  migratePersistedModelViewState,
  type PersistedModelViewState,
} from './model-view-state'
```

删除文件内重复的 `PersistedModelViewState` 和 `DEFAULT_MODEL_VIEW_STATE` 定义，并将 `loadModelViewState` 替换为：

```ts
function loadModelViewState(): PersistedModelViewState {
  try {
    const raw = localStorage.getItem(MODEL_VIEW_STATE_KEY)
    if (!raw) return { ...DEFAULT_MODEL_VIEW_STATE }

    const state = migratePersistedModelViewState(JSON.parse(raw))
    localStorage.setItem(MODEL_VIEW_STATE_KEY, JSON.stringify(state))
    return state
  } catch {
    return { ...DEFAULT_MODEL_VIEW_STATE }
  }
}
```

保留现有 `modelOffsetX/Y` refs 和持久化 watch，使对旧调用者的 store API 兼容，但它们初始化并持续保存为零。

- [ ] **Step 5：运行迁移测试、全量测试和 Node 类型检查**

Run:

```bash
npm test -- src/renderer/stores/model-view-state.test.ts
npm test
npx tsc --noEmit -p tsconfig.node.json
```

Expected: focused 3 项通过；全量 41 项通过；Node 类型检查退出 0。

- [ ] **Step 6：提交迁移**

```bash
git add deskpet-app/src/renderer/stores/model-view-state.ts deskpet-app/src/renderer/stores/model-view-state.test.ts deskpet-app/src/renderer/stores/deskpet.ts
git commit -m "fix: clear legacy model offsets"
```

## Task 3：从透明窗口卸载人物外 UI

**Files:**

- Create: `deskpet-app/src/renderer/components/DeskpetStage.structure.test.ts`
- Modify: `deskpet-app/src/renderer/components/DeskpetStage.vue`

- [ ] **Step 1：写失败的 SFC 结构测试**

创建 `src/renderer/components/DeskpetStage.structure.test.ts`：

```ts
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
    expect(shape.tags).not.toEqual(expect.arrayContaining(['ChatBubble', 'QuickInput']))
    expect(shape.classes).not.toEqual(expect.arrayContaining(['nav-bar', 'btn-bar']))
    expect(shape.events).not.toContain('dblclick')
    expect(shape.template).not.toContain('⚙')
    expect(shape.template).not.toContain('💬')
    expect(shape.template).not.toContain('🎤')
    expect(shape.scriptSetup).not.toContain('modelOffsetX')
    expect(shape.scriptSetup).not.toContain('modelOffsetY')
  })
})
```

- [ ] **Step 2：运行结构测试并确认 RED**

Run:

```bash
npm test -- src/renderer/components/DeskpetStage.structure.test.ts
```

Expected: FAIL，报告仍存在 `ChatBubble`、`QuickInput`、`nav-bar`、`btn-bar`、`dblclick` 和模型 offset 引用。

- [ ] **Step 3：将 Stage 模板收敛为模型和设置例外**

将 `DeskpetStage.vue` 的模板替换为：

```vue
<template>
  <div
    ref="deskpetStageRef"
    class="deskpet-stage"
    :class="{ hovered: isHovered, 'hover-fade-enabled': store.hoverFadeEnabled }"
    @mousedown.left="onPetMouseDown"
    @contextmenu="onPetContextMenu"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div ref="stageRef" class="live2d-stage" />

    <SettingsPanel :open="showSettings" @close="showSettings = false" />

    <div v-if="modelError" class="model-error">
      <div class="error-icon">!</div>
      <p>{{ modelError }}</p>
      <p class="error-hint" v-if="modelError.includes('Cubism')">
        从 <a href="https://www.live2d.com/download/cubism-sdk/" target="_blank" style="color:#4fc3f7">Live2D 官网</a>
        下载 Cubism SDK for Web，解压后将 <code>Core/live2dcubismcore.min.js</code> 放到
        <code>src/renderer/public/</code> 下，然后在 <code>index.html</code> 中添加
        <code>&lt;script src="./live2dcubismcore.min.js"&gt;&lt;/script&gt;</code>
      </p>
      <p class="error-hint" v-else>将模型放入 <code>src/renderer/public/models/</code> 后重启应用</p>
    </div>
  </div>
</template>
```

`model-error` 不加 `data-pet-ui`，因此模型缺失时不会产生人物之外的命中区域。

- [ ] **Step 4：删除 Stage 中不再使用的 UI 状态和依赖**

从 Vue import 中删除 `computed`，并删除这些 imports：

```ts
import ChatBubble from './ChatBubble.vue'
import QuickInput from './QuickInput.vue'
import { useChatStore } from '@/stores/chat'
import { useVoiceInput } from '@/composables/useVoiceInput'
```

删除 `chatStore`，并删除以下状态：

```ts
const inputText = ref('')
const showInput = ref(false)
const chatPanelOpen = ref(false)
```

删除 `useVoiceInput()`、`recordingActive`、`vadActive`、`toggleRecording()`、`onDoubleClick()` 和 `sendText()`。`transport` 继续保留，因为截图订阅仍调用 `transport.sendScreenshot()`。

- [ ] **Step 5：接入纯交互策略**

添加 import：

```ts
import { shouldPetWindowBeInteractive } from '@/services/interaction/pet-window-policy'
```

将 UI watch 收敛为：

```ts
watch(showSettings, () => {
  schedulePointerInteractiveSync()
}, { flush: 'post' })
```

将 `syncPointerInteractive` 替换为：

```ts
function syncPointerInteractive(clientX: number, clientY: number): void {
  const interactive = shouldPetWindowBeInteractive({
    dragActive: petDragActive,
    pointOverModel: isPointOverModel(clientX, clientY),
    settingsOpen: showSettings.value,
    pointOverSettings: isPointOverVisibleUi(clientX, clientY),
  })
  if (interactive === lastPointerInteractive) return
  lastPointerInteractive = interactive
  void window.electronAPI?.setPetHitTestInteractive(interactive)
}
```

`onPetMouseDown` 和 `onPetContextMenu` 继续在模型 bounds 外直接 return；设置面板自身的 `@mousedown.stop` 和 `[data-pet-ui]` marker 保持原行为。

- [ ] **Step 6：停止应用旧模型 offset**

在模型初次加载后保留 `resizeModel(...)`，删除：

```ts
model.position.x += store.modelOffsetX
model.position.y += store.modelOffsetY
```

在窗口 resize 分支保留 `resizeModelFit(...)`，删除同样的两行 offset 累加。人物始终由 `resizeModel` / `resizeModelFit` 和窗口中心定位。

- [ ] **Step 7：删除死 CSS**

从 `DeskpetStage.vue` scoped CSS 删除完整规则：

- `.nav-bar` 和 `.nav-bar::after`
- `.btn-bar`、`.btn-bar-item` 及其 hover/recording/vad/shifted 规则
- `@keyframes mic-pulse`
- `.chat-toggle` 和 `.chat-toggle:hover`

保留 `.deskpet-stage`、`.live2d-stage`、hover fade 和 `.model-error` 规则。

- [ ] **Step 8：运行结构测试、策略测试、全量测试和构建**

Run:

```bash
npm test -- src/renderer/components/DeskpetStage.structure.test.ts src/renderer/services/interaction/pet-window-policy.test.ts
npm test
npx tsc --noEmit -p tsconfig.node.json
npm run build
git diff --check
```

Expected:

- focused 2 个文件、6 项测试通过。
- 全量 8 个文件、42 项测试通过。
- Node 类型检查、生产构建和 diff 检查通过。
- `vue-tsc --noEmit` 仍可能报告导入基线已有的 Live2D/TTS/chat 类型错误，但不得新增 `DeskpetStage` 新代码错误。

- [ ] **Step 9：提交 model-only Stage**

```bash
git add deskpet-app/src/renderer/components/DeskpetStage.vue deskpet-app/src/renderer/components/DeskpetStage.structure.test.ts
git commit -m "feat: make the pet the only persistent hit area"
```

## Task 4：视觉与 Electron 实机验证

**Files:**

- No source files expected.

- [ ] **Step 1：启动开发应用**

Run:

```bash
cd deskpet-app
REMOTE_DEBUGGING_PORT=9222 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dev
```

Expected: renderer 监听 `http://localhost:5173/`，Electron 窗口打开，远程调试端口监听 9222。

- [ ] **Step 2：验证 renderer DOM 和视觉结果**

在 `http://localhost:5173/` 读取：

```js
({
  canvasCount: document.querySelectorAll('canvas').length,
  persistentUiCount: document.querySelectorAll(
    '.btn-bar, .nav-bar, .comic-bubbles, .chat-panel, .quick-input',
  ).length,
  modelError: document.querySelector('.model-error')?.textContent || null,
  hoverShadow: getComputedStyle(
    document.querySelector('.deskpet-stage'),
    '::after',
  ).boxShadow,
})
```

Expected: `canvasCount=1`、`persistentUiCount=0`、`modelError=null`、`hoverShadow='none'`。截图只显示人物，不显示齿轮、聊天、麦克风或底部短横条。

- [ ] **Step 3：验证旧 offset 已迁移**

通过 Electron renderer 读取 store：

```js
({
  x: store.modelOffsetX,
  y: store.modelOffsetY,
  bounds: model.getBounds(),
})
```

Expected: offset 为 `0,0`，转换后的 client bounds 与 600×800 窗口相交，人物可见。

- [ ] **Step 4：验证实际 Electron 交互**

1. 人物 bounds 内拖动约 40×30，`window-state.json` 中 BrowserWindow 坐标相应改变。
2. 记录窗口坐标后在透明角落拖动，窗口坐标保持不变。
3. 人物外左键点击不激活任何桌宠 UI；下层应用收到点击。
4. 人物内右键显示原生“设置 / 表情 / 动作”菜单。
5. 选择“设置”后只显示右侧设置面板；面板外透明区继续穿透。
6. 关闭设置后恢复仅人物命中。
7. 选择一个已验证表情和动作，继续走现有 store pending flow。

- [ ] **Step 5：执行最终验证套件**

Run:

```bash
npm test
npx tsc --noEmit -p tsconfig.node.json
npm run build
git diff --check
git status --short --branch
```

Expected: 42 项测试通过；Node 类型检查和构建退出 0；diff 检查无输出；工作树干净且位于 `feature/init`。

