<template>
  <div ref="deskpetStageRef" class="deskpet-stage" :class="{ hovered: isHovered, 'hover-fade-enabled': store.hoverFadeEnabled }" @mousedown.left="onPetMouseDown" @contextmenu="onPetContextMenu" @mouseenter="isHovered = true" @mouseleave="isHovered = false">
    <div ref="stageRef" class="live2d-stage" />

    <SettingsPanel
      :open="settingsPanelOpen"
      :left="settingsPanelLeft"
      :top="settingsPanelTop"
      :width="settingsPanelWidth"
      :height="settingsPanelHeight"
      @close="showSettings = false"
    />

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

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import SettingsPanel from './SettingsPanel.vue'
import { useDeskpetStore } from '@/stores/deskpet'
import { useChimeraTransport } from '@/services/transport/chimera'
import { useLive2DAnimation } from '@/composables/useLive2DAnimation'
import { useWindowDrag } from '@/composables/useWindowDrag'
import { useModelZoom } from '@/composables/useModelZoom'
import { useExpressionState } from '@/composables/useExpressionState'
import { usePetActionState } from '@/composables/usePetActionState'
import { useMotionPriority, MotionLayer } from '@/composables/useMotionPriority'
import { useIdleScheduler } from '@/composables/useIdleScheduler'
import { useLipSync } from '@/composables/useLipSync'
import { createPixiApp, loadLive2DModel, resizeModel, resizeModelFit } from '@/services/live2d/loader'
import { discoverModel } from '@/services/live2d/model-discovery'
import { getAnimationTarget, getEmotionTarget, loadEmotionAdapter } from '@/services/live2d/emotion-adapter'
import { isClientPointInsideModel, modelBoundsToClientBounds } from '@/services/live2d/model-bounds'
import { shouldPetWindowBeInteractive } from '@/services/interaction/pet-window-policy'
import { isPointOverVisibleUi as isClientPointOverVisibleUi } from '@/services/interaction/ui-hit-test'
import type { PetContextMenuCommand } from '../../shared/pet-context-menu'

const store = useDeskpetStore()
const MODEL_REFERENCE_WIDTH = 600
const MODEL_REFERENCE_HEIGHT = 800
const PET_WINDOW_PADDING = 8
const SETTINGS_PANEL_WIDTH = 280
const SETTINGS_PANEL_HEIGHT = 600
const transport = useChimeraTransport()
const { start: startAnim, stop: stopAnim } = useLive2DAnimation()
const { onWindowMouseDown, cleanup: cleanupWindowDrag } = useWindowDrag(
  undefined,
  onWindowDragActiveChange,
)

const deskpetStageRef = ref<HTMLDivElement>()
const stageRef = ref<HTMLDivElement>()
const isHovered = ref(false)
const showSettings = ref(false)
const settingsPanelOpen = ref(false)
const settingsPanelLeft = ref(0)
const settingsPanelTop = ref(0)
const settingsPanelWidth = ref(SETTINGS_PANEL_WIDTH)
const settingsPanelHeight = ref(SETTINGS_PANEL_HEIGHT)
const modelError = ref('')

let animFrameId = 0
let unsubscribeGlobalCursor: (() => void) | null = null
let unsubscribeResetModelView: (() => void) | null = null
let unsubscribeSetHoverFade: (() => void) | null = null
let unsubscribeScreenshot: (() => void) | null = null
let unsubscribePetContextCommand: (() => void) | null = null
let unsubscribePetWindowLayout: (() => void) | null = null
let lastPointerInteractive: boolean | null = null
let petDragActive = false
let pointerSyncFrameId = 0
let stageMutationObserver: MutationObserver | null = null
let petViewportWidth = 0
let petViewportHeight = 0
let petModelX = 0
let petModelY = 0
let layoutRequestGeneration = 0

onMounted(async () => {
  unsubscribePetContextCommand = window.electronAPI?.onPetContextMenuCommand(
    handlePetContextCommand,
  ) ?? null
  unsubscribePetWindowLayout = window.electronAPI?.onPetWindowLayoutChanged(
    applyPetWindowLayoutResult,
  ) ?? null
  unsubscribeGlobalCursor = window.electronAPI?.onGlobalCursorPosition?.((position) => {
    mouseX = position.x
    mouseY = position.y
    syncPointerInteractive(position.x, position.y)
  }) ?? null

  const stage = deskpetStageRef.value
  if (stage) {
    stageMutationObserver = new MutationObserver(schedulePointerInteractiveSync)
    stageMutationObserver.observe(stage, { childList: true, subtree: true })
  }

  const container = stageRef.value
  if (!container) return

  // clear any leftover canvas from HMR reloads
  container.innerHTML = ''

  // prevent duplicate model loads
  if (store.modelLoaded) {
    console.log('[Deskpet] Model already loaded, skipping')
    return
  }

  if (typeof (window as any).Live2DCubismCore === 'undefined') {
    modelError.value = '缺少 Cubism 4 运行时'
    return
  }

  const modelUrl = await discoverModel()
  if (!modelUrl) {
    modelError.value = '未找到 Live2D 模型文件，请将模型放入 public/models/ 目录'
    return
  }

  try {
    const app = await createPixiApp(container, window.innerWidth, window.innerHeight)
    store.pixiApp = app

    const model = await loadLive2DModel(modelUrl, app)
    store.emotionAdapter = await loadEmotionAdapter(modelUrl)
    resizeModel(model, MODEL_REFERENCE_WIDTH, MODEL_REFERENCE_HEIGHT, store.modelZoom)
    store.live2dModel = model
    store.modelLoaded = true
    schedulePointerInteractiveSync()
    idleScheduler.start()

    startAnim(model)
    const canvas = app.view as HTMLCanvasElement
    canvas.addEventListener('wheel', onWheel as any, { passive: false } as any)
    updatePetViewportFromModel()
    syncPetWindowLayout()
    console.log('[Deskpet] Live2D model loaded successfully')
  } catch (err) {
    console.error('[Deskpet] Failed to load Live2D model:', err)
    modelError.value = `模型加载失败: ${err}`
  }

  unsubscribeResetModelView = window.electronAPI?.onResetModelView?.(() => {
    resetModelView()
  }) ?? null
  unsubscribeSetHoverFade = window.electronAPI?.onSetHoverFade?.((enabled) => {
    store.hoverFadeEnabled = enabled
  }) ?? null
  unsubscribeScreenshot = window.electronAPI?.onScreenshotCaptured?.((base64) => {
    transport.sendScreenshot(base64)
  }) ?? null

  startAnimationPoll()
})

watch(() => store.currentEmotion, (emotion) => {
  if (!store.live2dModel || emotion === 'neutral' || emotion === 'idle') return
  const target = getEmotionTarget(store.emotionAdapter, emotion)
  if (target?.motion) {
    playMotionWithPriority(target.motion.group, MotionLayer.Reply, target.motion.index ?? 0)
    idleScheduler.notifyInteraction()
  }
})

let lastW = window.innerWidth
let lastH = window.innerHeight
let lastZoom = store.modelZoom
let mouseX = window.innerWidth / 2
let mouseY = window.innerHeight / 2

watch(showSettings, (open) => {
  schedulePointerInteractiveSync()
  if (!open) settingsPanelOpen.value = false
  void syncPetWindowLayout().then(() => {
    if (open && showSettings.value) settingsPanelOpen.value = true
  })
}, { flush: 'post' })

const { onWheel } = useModelZoom(
  store,
  () => ({ x: mouseX, y: mouseY }),
  (zoom) => {
    lastZoom = zoom
    updatePetViewportFromModel()
    syncPetWindowLayout()
    schedulePointerInteractiveSync()
  },
)
const { activateEmotionState, cleanup: cleanupExpression } = useExpressionState(store)
const { playActionEffect, cleanup: cleanupActionEffects } = usePetActionState(store)
const { playMotionWithPriority } = useMotionPriority(store)
const idleScheduler = useIdleScheduler(playMotionWithPriority)
const { getMouthOpen } = useLipSync()
const stopPendingAnimationWatch = watch(
  [() => store.pendingAnimation, () => store.live2dModel],
  ([pending, model]) => {
    if (pending && model) playPendingAnimation()
  },
  { flush: 'sync' },
)

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
  const stage = deskpetStageRef.value
  return Boolean(stage && isClientPointOverVisibleUi(stage, clientX, clientY))
}

function updatePetViewportFromModel(): void {
  const model = store.live2dModel
  const canvas = store.pixiApp?.view as HTMLCanvasElement | undefined
  if (!model || !canvas) return
  const bounds = modelBoundsToClientBounds(model.getBounds(), canvas)
  petViewportWidth = Math.ceil(bounds.width + PET_WINDOW_PADDING * 2)
  petViewportHeight = Math.ceil(bounds.height + PET_WINDOW_PADDING * 2)
}

async function syncPetWindowLayout(): Promise<void> {
  if (!petViewportWidth || !petViewportHeight) return
  const generation = ++layoutRequestGeneration
  const result = await window.electronAPI?.setPetWindowLayout({
    mode: showSettings.value ? 'settings' : 'compact',
    petWidth: petViewportWidth,
    petHeight: petViewportHeight,
    settingsWidth: SETTINGS_PANEL_WIDTH,
    settingsHeight: SETTINGS_PANEL_HEIGHT,
  })
  if (!result || generation !== layoutRequestGeneration) return
  applyPetWindowLayoutResult(result)
}

function applyPetWindowLayoutResult(result: PetWindowLayoutResult): void {
  petModelX = result.petX
  petModelY = result.petY
  settingsPanelLeft.value = result.settingsX
  settingsPanelTop.value = result.settingsY
  settingsPanelWidth.value = result.settingsWidth || SETTINGS_PANEL_WIDTH
  settingsPanelHeight.value = result.settingsHeight || SETTINGS_PANEL_HEIGHT
  positionModelForCurrentLayout(window.innerWidth, window.innerHeight)
  schedulePointerInteractiveSync()
}

function positionModelForCurrentLayout(width: number, height: number): void {
  const model = store.live2dModel
  if (!model) return
  model.position.set(
    petModelX || width / 2,
    petModelY || height / 2,
  )
}

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

function schedulePointerInteractiveSync(): void {
  if (pointerSyncFrameId) return
  pointerSyncFrameId = requestAnimationFrame(() => {
    pointerSyncFrameId = 0
    syncPointerInteractive(mouseX, mouseY)
  })
}

function onWindowDragActiveChange(active: boolean): void {
  petDragActive = active
  if (active) {
    syncPointerInteractive(mouseX, mouseY)
    return
  }
  schedulePointerInteractiveSync()
}

function onPetMouseDown(event: MouseEvent): void {
  if (
    isUiTarget(event.target)
    || isPointOverVisibleUi(event.clientX, event.clientY)
    || !isPointOverModel(event.clientX, event.clientY)
  ) return
  event.preventDefault()
  onWindowMouseDown(event)
}

function onPetContextMenu(event: MouseEvent): void {
  if (
    isUiTarget(event.target)
    || isPointOverVisibleUi(event.clientX, event.clientY)
    || !isPointOverModel(event.clientX, event.clientY)
  ) return
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
    const target = getEmotionTarget(store.emotionAdapter, command.id)
    if (!target) return
    if (store.currentEmotion !== command.id) {
      store.currentEmotion = command.id
      return
    }
    activateEmotionState(command.id)
    if (target.motion) {
      playMotionWithPriority(target.motion.group, MotionLayer.Reply, target.motion.index ?? 0)
      idleScheduler.notifyInteraction()
    }
    return
  }
  if (getAnimationTarget(store.emotionAdapter, command.id)) {
    store.pendingAnimation = command.id
    store.pendingAnimationLoop = false
  }
}

function playPendingAnimation(): void {
  const pending = store.consumePendingAnimation()
  if (!pending || !store.live2dModel) return
  const target = getAnimationTarget(store.emotionAdapter, pending.name)
  if (!target) {
    console.debug(`[Deskpet] No animation adapter target: ${pending.name}`)
    return
  }

  let played = false
  if (target.motion) {
    playMotionWithPriority(target.motion.group, MotionLayer.Reply, target.motion.index ?? 0)
    played = true
  }
  if (target.effect) {
    played = playActionEffect(target.effect) || played
  }
  if (played) {
    idleScheduler.notifyInteraction()
  }
}

function startAnimationPoll() {
  const tick = () => {
    if (store.live2dModel) {
      const cw = window.innerWidth
      const ch = window.innerHeight
      if (cw !== lastW || ch !== lastH) {
        store.pixiApp!.renderer.resize(cw * 2, ch * 2)
        store.pixiApp!.stage.scale.set(2)
        lastW = cw
        lastH = ch
        positionModelForCurrentLayout(cw, ch)
        schedulePointerInteractiveSync()
      }
      if (store.modelZoom !== lastZoom) {
        lastZoom = store.modelZoom
        resizeModel(
          store.live2dModel,
          MODEL_REFERENCE_WIDTH,
          MODEL_REFERENCE_HEIGHT,
          store.modelZoom,
        )
        positionModelForCurrentLayout(cw, ch)
        updatePetViewportFromModel()
        syncPetWindowLayout()
        schedulePointerInteractiveSync()
      }
      try { store.live2dModel.focus(mouseX, mouseY) } catch { /* focus not supported */ }
      try {
        (store.live2dModel as any).internalModel.coreModel.setParameterValueById('ParamMouthOpenY', getMouthOpen())
      } catch { /* lip sync param not available */ }
    }
    animFrameId = requestAnimationFrame(tick)
  }
  animFrameId = requestAnimationFrame(tick)
}

function onMouseMove(e: MouseEvent) {
  mouseX = e.clientX
  mouseY = e.clientY
  syncPointerInteractive(mouseX, mouseY)
}

window.addEventListener('mousemove', onMouseMove)
window.addEventListener('resize', schedulePointerInteractiveSync)
onUnmounted(() => {
  stopAnim()
  if (animFrameId) cancelAnimationFrame(animFrameId)
  cleanupWindowDrag()
  if (pointerSyncFrameId) cancelAnimationFrame(pointerSyncFrameId)
  pointerSyncFrameId = 0
  stageMutationObserver?.disconnect()
  stageMutationObserver = null
  unsubscribeGlobalCursor?.()
  unsubscribeGlobalCursor = null
  unsubscribePetContextCommand?.()
  unsubscribePetContextCommand = null
  unsubscribePetWindowLayout?.()
  unsubscribePetWindowLayout = null
  unsubscribeResetModelView?.()
  unsubscribeResetModelView = null
  unsubscribeSetHoverFade?.()
  unsubscribeSetHoverFade = null
  unsubscribeScreenshot?.()
  unsubscribeScreenshot = null
  cleanupExpression()
  cleanupActionEffects()
  stopPendingAnimationWatch()
  idleScheduler.stop()
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('resize', schedulePointerInteractiveSync)
  void window.electronAPI?.setPetHitTestInteractive(true)
  if (store.pixiApp) {
    const canvas = store.pixiApp.view as HTMLCanvasElement
    canvas.removeEventListener('wheel', onWheel as any)
    store.pixiApp.destroy(true, { children: true, texture: true })
    store.pixiApp = null
  }
  store.live2dModel = null
  store.emotionAdapter = null
  store.modelLoaded = false
})

function resetModelView() {
  store.resetModelView()
  if (store.live2dModel) {
    resizeModelFit(
      store.live2dModel,
      MODEL_REFERENCE_WIDTH,
      MODEL_REFERENCE_HEIGHT,
      store.modelZoom,
    )
    positionModelForCurrentLayout(window.innerWidth, window.innerHeight)
    updatePetViewportFromModel()
    syncPetWindowLayout()
    lastZoom = store.modelZoom
    schedulePointerInteractiveSync()
  }
}

onUnmounted(() => { /* cleanup in stopAnim + pixiApp.destroy */ })
</script>

<style scoped>
.deskpet-stage {
  width: 100vw;
  height: 100vh;
  position: relative;
  -webkit-app-region: no-drag;
  user-select: none;
}

.live2d-stage {
  width: 100%;
  height: 100%;
  display: block;
  transition: opacity 0.18s ease;
}

.deskpet-stage.hover-fade-enabled.hovered .live2d-stage {
  opacity: 0.15;
}

.model-error {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  text-align: center;
  color: rgba(255, 255, 255, 0.9);
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(16px);
  padding: 40px;
  border-radius: 20px;
  max-width: 350px;
  -webkit-app-region: no-drag;
}
.model-error p {
  font-size: 15px;
  margin: 8px 0;
  line-height: 1.6;
}
.model-error .error-icon {
  font-size: 48px;
  margin-bottom: 12px;
}
.model-error .error-hint {
  font-size: 13px;
  opacity: 0.7;
}
.model-error code {
  background: rgba(255, 255, 255, 0.15);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}
</style>
