<template>
  <div
    ref="deskpetStageRef"
    class="deskpet-stage"
    :class="{ hovered: isHovered, 'hover-fade-enabled': store.hoverFadeEnabled }"
    @mousedown.left="onPetMouseDown"
    @mouseup.left="onPetMouseUp"
    @contextmenu="onPetContextMenu"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
    @dragenter.prevent="onFileDragEnter"
    @dragover.prevent
    @dragleave="onFileDragLeave"
    @drop.prevent="onFileDrop"
  >
    <div ref="stageRef" class="live2d-stage" />

    <PetInteraction
      :pet-x="petModelX || lastW / 2"
      :pet-y="petModelY || lastH / 2"
      :pet-width="petViewportWidth"
      :pet-height="petViewportHeight"
      :screenshot-preview="pendingScreenshot"
      @submit="submitUserMessage"
      @voice-start="startVoiceInput"
      @voice-stop="stopVoiceInput"
      @interrupt="interruptAgent"
      @retry="retryRequest"
      @capture-screen="captureCurrentScreen"
      @confirm-screenshot="confirmScreenshot"
      @cancel-screenshot="pendingScreenshot = ''"
      @chat-after-leave="onChatAfterLeave"
    />

    <AgentTaskPanel
      v-if="agent.sourceName || agent.confirmation || agent.taskResult"
      @interrupt="interruptAgent"
      @confirm="respondToConfirmation"
      @save="saveTaskResult"
    />

    <div v-if="fileDragActive" class="file-drop-hint" data-pet-ui>
      松开交给麦麦
    </div>

    <SettingsPanel
      :open="settingsPanelOpen"
      :onboarding="onboardingOpen"
      :left="settingsPanelLeft"
      :top="settingsPanelTop"
      :width="settingsPanelWidth"
      :height="settingsPanelHeight"
      @close="closeSettings"
      @configured="completeOnboarding"
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
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import SettingsPanel from './SettingsPanel.vue'
import PetInteraction from './PetInteraction.vue'
import AgentTaskPanel from './AgentTaskPanel.vue'
import { useDeskpetStore } from '@/stores/deskpet'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { useAiConfigStore } from '@/stores/ai-config'
import { useChimeraTransport } from '@/services/transport/chimera'
import { useLive2DAnimation } from '@/composables/useLive2DAnimation'
import { useWindowDrag } from '@/composables/useWindowDrag'
import { useModelZoom } from '@/composables/useModelZoom'
import { useExpressionState } from '@/composables/useExpressionState'
import { usePetActionState } from '@/composables/usePetActionState'
import { useMotionPriority, MotionLayer } from '@/composables/useMotionPriority'
import { useIdleScheduler } from '@/composables/useIdleScheduler'
import { useAgentSpeech } from '@/composables/useAgentSpeech'
import { useAgentRequestWorkflow } from '@/composables/useAgentRequestWorkflow'
import { hasLegalConsent } from '../../shared/legal'
import { useProactiveCompanion } from '@/composables/useProactiveCompanion'
import { createPixiApp, loadLive2DModel, resizeModel, resizeModelFit } from '@/services/live2d/loader'
import { discoverModel } from '@/services/live2d/model-discovery'
import { getAnimationTarget, getEmotionTarget, loadEmotionAdapter } from '@/services/live2d/emotion-adapter'
import { isClientPointInsideModel, modelBoundsToClientBounds } from '@/services/live2d/model-bounds'
import { shouldPetWindowBeInteractive } from '@/services/interaction/pet-window-policy'
import { isPointOverVisibleUi as isClientPointOverVisibleUi } from '@/services/interaction/ui-hit-test'
import type { PetContextMenuCommand } from '../../shared/pet-context-menu'
import type { NativeReminder } from '../../shared/native-tools'

const store = useDeskpetStore()
const MODEL_REFERENCE_WIDTH = 600
const MODEL_REFERENCE_HEIGHT = 800
const PET_WINDOW_PADDING = 8
const SETTINGS_PANEL_WIDTH = 320
const SETTINGS_PANEL_HEIGHT = 640
const AGENT_PANEL_WIDTH = 460
const AGENT_PANEL_HEIGHT = 560
const MAX_AGENT_FILE_BYTES = 12 * 1024 * 1024
const transport = useChimeraTransport()
const agent = useAgentStore()
const aiConfig = useAiConfigStore()
const chat = useChatStore()
const proactiveCompanion = useProactiveCompanion(agent)
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
const onboardingOpen = ref(false)
const settingsPanelLeft = ref(0)
const settingsPanelTop = ref(0)
const settingsPanelWidth = ref(SETTINGS_PANEL_WIDTH)
const settingsPanelHeight = ref(SETTINGS_PANEL_HEIGHT)
const modelError = ref('')
const fileDragActive = ref(false)
const chatLayoutOpen = ref(agent.chatOpen)
const speech = useAgentSpeech(agent, chat)
const requestWorkflow = useAgentRequestWorkflow({
  agent,
  chat,
  transport,
  requireLegalConsent,
  cancelSpeech: speech.cancel,
  isSpeaking: speech.isSpeaking,
})
const {
  pendingScreenshot,
  submitUserMessage,
  retryRequest,
  startVoiceInput,
  stopVoiceInput,
  interruptAgent,
  previewScreenshot,
  confirmScreenshot,
  captureCurrentScreen,
  respondToConfirmation,
  saveTaskResult,
} = requestWorkflow
const expandedUiOpen = computed(() => Boolean(
  showSettings.value || chatLayoutOpen.value || agent.workspaceOpen || chat.chatBubble.visible,
))

let animFrameId = 0
let unsubscribeGlobalCursor: (() => void) | null = null
let unsubscribeResetModelView: (() => void) | null = null
let unsubscribeSetHoverFade: (() => void) | null = null
let unsubscribeScreenshot: (() => void) | null = null
let unsubscribeNativeReminder: (() => void) | null = null
let unsubscribePetContextCommand: (() => void) | null = null
let unsubscribePetWindowLayout: (() => void) | null = null
let lastPointerInteractive: boolean | null = null
let petDragActive = false
let pointerSyncFrameId = 0
let stageMutationObserver: MutationObserver | null = null
const petViewportWidth = ref(0)
const petViewportHeight = ref(0)
const petModelX = ref(0)
const petModelY = ref(0)
let layoutRequestGeneration = 0
let pointerDownScreenPosition: { x: number; y: number } | null = null
let compactLayoutPending = false

onMounted(async () => {
  await Promise.all([
    aiConfig.load(),
    chat.hydrateSecureStorage(),
    agent.hydrateSecureStorage(),
  ])
  if (
    !aiConfig.ready
    || !aiConfig.capabilitiesChecked
    || !aiConfig.textSupported
    || !aiConfig.streamingSupported
    || !hasLegalConsent()
  ) {
    onboardingOpen.value = true
    showSettings.value = true
    settingsPanelOpen.value = true
  }
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
  unsubscribeNativeReminder = window.electronAPI?.onNativeReminderTriggered?.((reminder: NativeReminder) => {
    agent.proactiveMessage = `提醒：${reminder.body}`
    store.currentEmotion = 'happy'
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
    proactiveCompanion.start()

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
  unsubscribeScreenshot = window.electronAPI?.onScreenshotCaptured?.(previewScreenshot) ?? null

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

watch([expandedUiOpen, showSettings], async () => {
  schedulePointerInteractiveSync()
  if (!showSettings.value) settingsPanelOpen.value = false
  try {
    await syncPetWindowLayout()
  } finally {
    if (showSettings.value) settingsPanelOpen.value = true
  }
}, { flush: 'post' })

watch(() => agent.chatOpen, (open) => {
  if (open) chatLayoutOpen.value = true
}, { flush: 'sync' })

function onChatAfterLeave(): void {
  if (!agent.chatOpen) chatLayoutOpen.value = false
}

function closeSettings(): void {
  showSettings.value = false
}

function completeOnboarding(): void {
  onboardingOpen.value = false
  showSettings.value = false
}

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
const { playActionEffect, stopActionEffect, cleanup: cleanupActionEffects } = usePetActionState(store)
const { playMotionWithPriority } = useMotionPriority(store)
const idleScheduler = useIdleScheduler(playMotionWithPriority)
const stopPendingAnimationWatch = watch(
  [() => store.pendingAnimation, () => store.live2dModel],
  ([pending, model]) => {
    if (pending && model) playPendingAnimation()
  },
  { flush: 'sync' },
)

watch(() => agent.state, (state) => {
  const stateBehavior: Partial<Record<typeof state, { emotion: string; action?: string; loop?: boolean }>> = {
    idle: { emotion: 'neutral' },
    listening: { emotion: 'curious' },
    thinking: { emotion: 'thinking' },
    planning: { emotion: 'thinking', action: 'walk', loop: true },
    executing: { emotion: 'curious', action: 'walk', loop: true },
    awaiting_confirmation: { emotion: 'curious', action: 'wave' },
    speaking: { emotion: 'neutral' },
    success: { emotion: 'happy', action: 'cheer' },
    error: { emotion: 'sad' },
    interrupted: { emotion: 'neutral' },
  }
  const behavior = stateBehavior[state]
  if (!behavior) return
  idleScheduler.notifyInteraction()
  store.currentEmotion = behavior.emotion
  if (behavior.action) {
    store.pendingAnimation = behavior.action
    store.pendingAnimationLoop = Boolean(behavior.loop)
  } else {
    stopActionEffect()
  }
})

watch(() => agent.currentRole, (roleId, previousRole) => {
  if (roleId === previousRole) return
  speech.cancel()
  const requestId = agent.activeRequestId
  if (requestId && agent.confirmation) {
    transport.sendConfirmation(requestId, false)
  } else if (requestId && agent.interruptible) {
    transport.sendInterrupt(requestId)
    requestWorkflow.clearRequestTimer(requestId)
  }
  chat.hideChatBubble()
  chat.setActiveRole(roleId)
  agent.proactiveMessage = ''
  agent.activeRequestId = ''
  agent.taskPanelOpen = false
  agent.setConfirmation(null)
  agent.applyState({ requestId: '', state: 'idle', progress: 0, step: '', interruptible: false })
}, { immediate: true })

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
  petViewportWidth.value = Math.ceil(bounds.width + PET_WINDOW_PADDING * 2)
  petViewportHeight.value = Math.ceil(bounds.height + PET_WINDOW_PADDING * 2)
}

async function syncPetWindowLayout(): Promise<void> {
  if (!petViewportWidth.value || !petViewportHeight.value) return
  const generation = ++layoutRequestGeneration
  const mode = expandedUiOpen.value ? 'settings' : 'compact'
  if (mode === 'compact') compactLayoutPending = true
  const result = await window.electronAPI?.setPetWindowLayout({
    mode,
    petWidth: petViewportWidth.value,
    petHeight: petViewportHeight.value,
    settingsWidth: showSettings.value ? SETTINGS_PANEL_WIDTH : AGENT_PANEL_WIDTH,
    settingsHeight: showSettings.value ? SETTINGS_PANEL_HEIGHT : AGENT_PANEL_HEIGHT,
  })
  if (!result || generation !== layoutRequestGeneration) {
    if (generation === layoutRequestGeneration && mode === 'compact') compactLayoutPending = false
    return
  }
  applyPetWindowLayoutResult(result)
  if (mode === 'compact') {
    compactLayoutPending = false
    renderPetFrame()
  }
}

function applyPetWindowLayoutResult(result: PetWindowLayoutResult): void {
  petModelX.value = result.petX
  petModelY.value = result.petY
  settingsPanelLeft.value = result.settingsX
  settingsPanelTop.value = result.settingsY
  settingsPanelWidth.value = result.settingsWidth || SETTINGS_PANEL_WIDTH
  settingsPanelHeight.value = result.settingsHeight || SETTINGS_PANEL_HEIGHT
  positionModelForCurrentLayout(window.innerWidth, window.innerHeight)
  renderPetFrame()
  schedulePointerInteractiveSync()
}

function positionModelForCurrentLayout(width: number, height: number): void {
  const model = store.live2dModel
  if (!model) return
  if (compactLayoutPending) {
    model.position.set(width / 2, height / 2)
    return
  }
  model.position.set(
    petModelX.value || width / 2,
    petModelY.value || height / 2,
  )
}

function renderPetFrame(): void {
  const app = store.pixiApp
  if (app) app.renderer.render(app.stage)
}

function syncPixiViewportToWindow(): void {
  if (!store.live2dModel || !store.pixiApp) return
  const width = window.innerWidth
  const height = window.innerHeight
  if (width === lastW && height === lastH) return
  store.pixiApp.renderer.resize(width * 2, height * 2)
  store.pixiApp.stage.scale.set(2)
  lastW = width
  lastH = height
  positionModelForCurrentLayout(width, height)
  renderPetFrame()
  schedulePointerInteractiveSync()
}

function syncPointerInteractive(clientX: number, clientY: number): void {
  const interactive = shouldPetWindowBeInteractive({
    dragActive: petDragActive,
    pointOverModel: isPointOverModel(clientX, clientY),
    settingsOpen: expandedUiOpen.value,
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
  pointerDownScreenPosition = { x: event.screenX, y: event.screenY }
  onWindowMouseDown(event)
}

function onPetMouseUp(event: MouseEvent): void {
  const start = pointerDownScreenPosition
  pointerDownScreenPosition = null
  if (!start) return
  const distance = Math.hypot(event.screenX - start.x, event.screenY - start.y)
  if (distance > 5) return
  agent.proactiveMessage = ''
  agent.chatOpen = true
}

function requireLegalConsent(): boolean {
  if (hasLegalConsent()) return true
  onboardingOpen.value = true
  showSettings.value = true
  settingsPanelOpen.value = true
  agent.chatOpen = false
  return false
}

function onFileDragEnter(event: DragEvent): void {
  if (event.dataTransfer?.types.includes('Files')) fileDragActive.value = true
}

function onFileDragLeave(event: DragEvent): void {
  if (event.relatedTarget instanceof Node && deskpetStageRef.value?.contains(event.relatedTarget)) return
  fileDragActive.value = false
}

async function onFileDrop(event: DragEvent): Promise<void> {
  fileDragActive.value = false
  if (!isPointOverModel(event.clientX, event.clientY)) return
  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (!extension || !['pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'heic', 'webp', 'tif', 'tiff', 'txt', 'md', 'markdown', 'json', 'csv', 'log'].includes(extension)) {
    agent.chatOpen = true
    agent.applyState({ requestId: '', state: 'error', error: '目前支持 PDF、DOCX、XLSX、图片、TXT、Markdown、JSON 和 CSV 文件' })
    return
  }
  if (file.size > MAX_AGENT_FILE_BYTES) {
    agent.chatOpen = true
    agent.applyState({ requestId: '', state: 'error', error: '文件不能超过 12MB' })
    return
  }

  await requestWorkflow.submitFiles(
    '请总结这份文件，提取关键结论，并生成清晰可执行的待办事项。',
    [file],
  )
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
    currentRole: agent.currentRole,
  })
}

function handlePetContextCommand(command: PetContextMenuCommand): void {
  if (command.type === 'settings') {
    showSettings.value = true
    settingsPanelOpen.value = true
    return
  }
  if (command.type === 'role') {
    agent.currentRole = command.id
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
    played = playActionEffect(target.effect, pending.loop) || played
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
        syncPixiViewportToWindow()
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
        (store.live2dModel as any).internalModel.coreModel.setParameterValueById('ParamMouthOpenY', speech.getMouthOpen())
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

function onWindowResize() {
  syncPixiViewportToWindow()
  schedulePointerInteractiveSync()
}

window.addEventListener('mousemove', onMouseMove)
window.addEventListener('resize', onWindowResize)
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
  unsubscribeNativeReminder?.()
  unsubscribeNativeReminder = null
  cleanupExpression()
  cleanupActionEffects()
  proactiveCompanion.stop()
  speech.cleanup()
  stopPendingAnimationWatch()
  idleScheduler.stop()
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('resize', onWindowResize)
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

.file-drop-hint {
  position: absolute;
  z-index: 45;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  padding: 6px 9px;
  border: 1px solid rgba(85,119,167,.55);
  border-radius: 6px;
  color: #314763;
  background: rgba(250,250,248,.95);
  font-size: 11px;
  pointer-events: none;
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
