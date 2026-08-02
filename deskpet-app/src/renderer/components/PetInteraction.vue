<template>
  <div class="pet-interaction" :style="anchorStyle">
    <Transition name="bubble-pop">
      <div v-if="bubbleText && !agent.chatOpen" class="pet-bubble" data-pet-ui @mousedown.stop>
        <div v-if="stateLabel" class="state-line">
          <span class="state-dot" />{{ stateLabel }}
        </div>
        <p>{{ bubbleText }}</p>
        <button
          v-if="agent.interruptible"
          class="inline-command"
          type="button"
          @click="$emit('interrupt')"
        >
          <Square :size="13" /> 停止
        </button>
      </div>
    </Transition>

    <Transition name="toolbar-pop" @after-leave="$emit('chat-after-leave')">
      <div
        v-if="agent.chatOpen"
        ref="controlsRef"
        class="interaction-controls expanded conversation-expanded"
        :class="{ dragging: draggingSurface, resizing: resizingSurface }"
        data-pet-ui
        @mousedown.stop
      >
        <div class="panel-resize-edge top" @pointerdown="startSurfaceResize($event, 'height')" />
        <div class="panel-resize-edge right" @pointerdown="startSurfaceResize($event, 'width')" />
        <div class="panel-resize-corner" @pointerdown="startSurfaceResize($event, 'both')" />
        <section class="conversation-section">
          <header class="chat-header" @pointerdown="startSurfaceDrag">
            <div class="header-leading">
              <button class="icon-button compact" type="button" title="会话记录" @click="toggleSessionDrawer">
                <PanelLeft :size="16" />
              </button>
              <button class="role-switcher" type="button" :disabled="workspaceBusy" @click="toggleRoleMenu">
                <Sparkles v-if="agent.currentRole === 'default'" :size="15" />
                <ChartCandlestick v-else :size="15" />
                <span>{{ currentProfile.name }}</span>
                <ChevronDown :size="14" />
              </button>
            </div>
            <div class="header-actions">
              <span v-if="activeStateLabel" class="agent-state"><span class="state-dot" />{{ activeStateLabel }}</span>
              <button
                class="icon-button compact"
                type="button"
                title="新建会话"
                :disabled="workspaceBusy"
                @click="createConversation"
              >
                <SquarePen :size="16" />
              </button>
              <button
                v-if="agent.interruptible"
                class="icon-button danger"
                type="button"
                title="停止当前回答"
                @click="$emit('interrupt')"
              >
                <Square :size="15" />
              </button>
              <button class="icon-button" type="button" title="收起对话" @click="closeChat">
                <X :size="17" />
              </button>
            </div>
          </header>
          <div v-if="roleMenuOpen" class="role-menu">
            <button
              v-for="profile in roleOptions"
              :key="profile.roleId"
              type="button"
              :class="{ selected: profile.roleId === agent.currentRole }"
              @click="selectRole(profile.roleId)"
            >
              <Sparkles v-if="profile.roleId === 'default'" :size="16" />
              <ChartCandlestick v-else :size="16" />
              <span>{{ profile.name }}</span>
              <Check v-if="profile.roleId === agent.currentRole" :size="15" />
            </button>
          </div>
          <ConversationDrawer
            v-if="sessionDrawerOpen"
            :workspace-busy="workspaceBusy"
            @close="sessionDrawerOpen = false"
            @focus-composer="focusComposer"
          />
          <ChatMessageList
            ref="messageListRef"
            :follow-up-target="followUpTarget"
            :workspace-busy="workspaceBusy"
            @retry="$emit('retry', $event)"
            @continue-generation="$emit('continue-generation', $event)"
            @continue-question="continueQuestion"
            @clarify="$emit('clarify', $event)"
            @expand-chart="$emit('expand-chart', $event)"
          />
        </section>
        <p v-if="currentProfile.riskNotice" class="risk-notice">{{ currentProfile.riskNotice }}</p>
        <div v-if="followUpTarget" class="followup-context">
          <Reply :size="14" />
          <span><small>{{ followUpTarget.preview }}</small></span>
          <button type="button" title="取消追问" @click="clearFollowUp"><X :size="14" /></button>
        </div>
        <div v-if="pendingAttachments.length" class="attachment-preview">
          <div v-for="attachment in pendingAttachments" :key="attachmentKey(attachment)" class="attachment-item">
            <FileText :size="15" />
            <span><strong>{{ attachment.name }}</strong><small>{{ formatFileSize(attachment.size) }}</small></span>
            <button type="button" title="移除附件" @click="removeAttachment(attachment)"><X :size="14" /></button>
          </div>
        </div>
        <div v-if="screenshotPreview" class="screenshot-preview">
          <img :src="`data:image/png;base64,${screenshotPreview}`" alt="待发送的屏幕截图" />
          <span><strong>屏幕截图</strong><small>确认后才会发送给 AI</small></span>
          <button type="button" title="取消截图" @click="$emit('cancel-screenshot')"><X :size="14" /></button>
          <button class="confirm" type="button" title="发送截图" @click="$emit('confirm-screenshot')"><Check :size="14" /></button>
        </div>
        <p v-if="attachmentError" class="attachment-error">{{ attachmentError }}</p>
        <div v-if="attachmentMenuOpen" class="attachment-menu">
          <button type="button" :disabled="pendingAttachments.length >= 3" @click="openFilePicker">
            <FilePlus2 :size="16" /><span>选择文件</span>
          </button>
          <button
            type="button"
            :disabled="!aiConfig.visionSupported"
            :title="aiConfig.visionSupported ? '选择屏幕区域' : '请先在设置中检测并启用视觉模型'"
            @click="captureCurrentScreen"
          >
            <ScanSearch :size="16" /><span>选择屏幕区域</span>
          </button>
        </div>
        <div class="input-row">
          <input ref="fileInputRef" class="file-input" type="file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.heic,.webp,.tif,.tiff,.txt,.md,.markdown,.json,.csv,.log" multiple @change="onFileSelected" />
          <button
            class="icon-button"
            :class="{ active: attachmentMenuOpen }"
            type="button"
            title="添加上下文"
            :disabled="workspaceBusy"
            @click="toggleAttachmentMenu"
          >
            <Paperclip :size="17" />
          </button>
          <textarea
            ref="inputRef"
            v-model="draftText"
            rows="1"
            :placeholder="followUpTarget ? '输入追问...' : '说点什么...'"
            @input="resizeComposer"
            @keydown.enter.exact.prevent="submit"
          ></textarea>
          <button
            class="icon-button"
            :class="{ recording: agent.recording }"
            type="button"
            title="按住说话"
            :disabled="workspaceBusy"
            @pointerdown.prevent="$emit('voice-start')"
            @pointerup.prevent="$emit('voice-stop')"
            @pointercancel="$emit('voice-stop')"
          >
            <Mic :size="18" />
          </button>
          <button class="icon-button accent" type="button" title="发送" :disabled="workspaceBusy || (!draftText.trim() && !pendingAttachments.length)" @click="submit">
            <Send :size="17" />
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  ChartCandlestick,
  Check,
  ChevronDown,
  FileText,
  FilePlus2,
  Mic,
  PanelLeft,
  Paperclip,
  Reply,
  ScanSearch,
  Send,
  Sparkles,
  Square,
  SquarePen,
  X,
} from 'lucide-vue-next'
import ChatMessageList from './ChatMessageList.vue'
import ConversationDrawer from './ConversationDrawer.vue'
import { useAgentStore } from '@/stores/agent'
import { useAiConfigStore } from '@/stores/ai-config'
import { useChatStore, type ChatReplyReference } from '@/stores/chat'
import { clampPetSurfacePosition, clampPetSurfaceSize, placePetSurface } from '@/services/interaction/pet-ui-position'
import { CHAT_COMPOSER_MIN_HEIGHT, chatComposerHeight } from '@/services/interaction/chat-composer-size'
import { ROLE_IDS, ROLE_PROFILES, type RoleId } from '../../shared/roles'

const props = defineProps<{
  petX: number
  petY: number
  petWidth: number
  petHeight: number
  screenshotPreview: string
}>()

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: File[]; replyTo?: ChatReplyReference }]
  'voice-start': []
  'voice-stop': []
  interrupt: []
  retry: [requestId: string]
  'continue-generation': [requestId: string]
  clarify: [payload: { messageId: string; value: string }]
  'expand-chart': [requestId: string]
  'capture-screen': []
  'confirm-screenshot': []
  'cancel-screenshot': []
  'chat-after-leave': []
}>()

const agent = useAgentStore()
const aiConfig = useAiConfigStore()
const chat = useChatStore()
const roleMenuOpen = ref(false)
const attachmentMenuOpen = ref(false)
const sessionDrawerOpen = ref(false)
const followUpTarget = ref<ChatReplyReference>()
const pendingAttachments = ref<File[]>([])
const attachmentError = ref('')
const inputRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()
const composerHeight = ref(CHAT_COMPOSER_MIN_HEIGHT)
const controlsRef = ref<HTMLDivElement>()
const messageListRef = ref<{
  isNearBottom: () => boolean
  scrollToBottom: () => void
}>()
const viewportWidth = ref(window.innerWidth)
const viewportHeight = ref(window.innerHeight)
const controlsOffset = ref<{ x: number; y: number } | null>(null)
const CHAT_PANEL_SIZE_KEY = 'deskpet/chat-panel-size-v1'
const MIN_CONTROLS_WIDTH = 280
const MIN_CONTROLS_HEIGHT = 280
const controlsSize = ref(loadControlsSize())
const draggingSurface = ref(false)
const resizingSurface = ref(false)
let dragPointerId = -1
let dragOffsetX = 0
let dragOffsetY = 0
let resizePointerId = -1
let resizeStartX = 0
let resizeStartY = 0
let resizeStartWidth = 0
let resizeStartHeight = 0
let resizeStartLeft = 0
let resizeStartBottom = 0
let resizeAxis: 'width' | 'height' | 'both' = 'both'
let viewportObserver: ResizeObserver | null = null

function loadControlsSize(): { width: number; height: number } | null {
  try {
    const value = JSON.parse(localStorage.getItem(CHAT_PANEL_SIZE_KEY) || 'null') as Record<string, unknown> | null
    if (!value || typeof value.width !== 'number' || typeof value.height !== 'number') return null
    if (!Number.isFinite(value.width) || !Number.isFinite(value.height)) return null
    return { width: value.width, height: value.height }
  } catch {
    return null
  }
}

function persistControlsSize() {
  try {
    if (controlsSize.value) localStorage.setItem(CHAT_PANEL_SIZE_KEY, JSON.stringify(controlsSize.value))
    else localStorage.removeItem(CHAT_PANEL_SIZE_KEY)
  } catch { /* localStorage unavailable */ }
}

function updateViewport() {
  viewportWidth.value = window.innerWidth
  viewportHeight.value = window.innerHeight
}

onMounted(() => {
  if (!aiConfig.loaded) void aiConfig.load()
  updateViewport()
  window.addEventListener('resize', updateViewport)
  viewportObserver = new ResizeObserver(updateViewport)
  viewportObserver.observe(document.documentElement)
  window.addEventListener('pointermove', onSurfacePointerMove)
  window.addEventListener('pointermove', onSurfaceResizeMove)
  window.addEventListener('pointerup', stopSurfaceDrag)
  window.addEventListener('pointerup', stopSurfaceResize)
  window.addEventListener('pointercancel', stopSurfaceDrag)
  window.addEventListener('pointercancel', stopSurfaceResize)
})
onUnmounted(() => {
  window.removeEventListener('resize', updateViewport)
  viewportObserver?.disconnect()
  viewportObserver = null
  window.removeEventListener('pointermove', onSurfacePointerMove)
  window.removeEventListener('pointermove', onSurfaceResizeMove)
  window.removeEventListener('pointerup', stopSurfaceDrag)
  window.removeEventListener('pointerup', stopSurfaceResize)
  window.removeEventListener('pointercancel', stopSurfaceDrag)
  window.removeEventListener('pointercancel', stopSurfaceResize)
})

function surfacePosition(width: number, height: number) {
  return placePetSurface({
    viewportWidth: viewportWidth.value,
    viewportHeight: viewportHeight.value,
    petX: props.petX,
    petY: props.petY,
    petWidth: props.petWidth,
    petHeight: props.petHeight,
    surfaceWidth: width,
    surfaceHeight: height,
  })
}

function resolveSurfacePosition(
  offset: { x: number; y: number } | null,
  automatic: { left: number; top: number },
  width: number,
  height: number,
) {
  if (!offset) return automatic
  return clampPetSurfacePosition({
    left: automatic.left + offset.x,
    top: automatic.top + offset.y,
    viewportWidth: viewportWidth.value,
    viewportHeight: viewportHeight.value,
    surfaceWidth: width,
    surfaceHeight: height,
  })
}

const stateLabels: Record<string, string> = {
  listening: '正在聆听',
  thinking: '正在思考',
  planning: '正在规划',
  executing: '正在执行',
  awaiting_confirmation: '等待确认',
  speaking: '正在回答',
  success: '已完成',
  error: '遇到问题',
  interrupted: '已停止',
}

const stateLabel = computed(() => stateLabels[agent.state] || '')
const activeStateLabel = computed(() => (
  ['idle', 'success'].includes(agent.state)
    ? ''
    : agent.state === 'speaking' && agent.currentStep
      ? agent.currentStep
      : stateLabel.value
))
const currentProfile = computed(() => ROLE_PROFILES[agent.currentRole])
const workspaceBusy = computed(() => agent.interruptible || Boolean(agent.confirmation))
const roleOptions = ROLE_IDS.map((roleId) => ROLE_PROFILES[roleId])
const draftText = computed({
  get: () => chat.draftsByRole[agent.currentRole],
  set: (value: string) => chat.setDraft(agent.currentRole, value),
})
const messageActivity = computed(() => chat.messages.map((message) => (
  message.type === 'thought'
    ? `${message.id}:${message.steps.length}:${message.collapsed}`
    : `${message.id}:${message.type === 'text' ? message.text.length : message.type}`
)).join('|'))

function resizeComposer() {
  const input = inputRef.value
  if (!input) return

  const previousWrap = input.getAttribute('wrap')
  input.setAttribute('wrap', 'off')
  input.style.height = '0px'
  const fitsSingleLine = !input.value.includes('\n') && input.scrollWidth <= input.clientWidth
  if (previousWrap === null) input.removeAttribute('wrap')
  else input.setAttribute('wrap', previousWrap)

  input.style.height = '0px'
  composerHeight.value = chatComposerHeight(input.value, input.scrollHeight, fitsSingleLine)
  input.style.height = `${composerHeight.value}px`
}

async function focusComposer() {
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  resizeComposer()
  inputRef.value?.focus()
}

watch(messageActivity, async () => {
  const list = messageListRef.value
  if (!list || !agent.chatOpen) return
  const nearBottom = list.isNearBottom()
  await nextTick()
  if (nearBottom) list.scrollToBottom()
})

watch(draftText, async () => {
  await nextTick()
  resizeComposer()
})

watch(() => agent.chatOpen, async (open) => {
  if (!open) {
    roleMenuOpen.value = false
    attachmentMenuOpen.value = false
    sessionDrawerOpen.value = false
    return
  }
  await nextTick()
  messageListRef.value?.scrollToBottom()
  await focusComposer()
}, { flush: 'post', immediate: true })

watch(() => chat.activeConversation.id, async () => {
  followUpTarget.value = undefined
  await nextTick()
  messageListRef.value?.scrollToBottom()
  await focusComposer()
})

watch(() => agent.interruptible, async (interruptible) => {
  if (interruptible || !agent.chatOpen) return
  await focusComposer()
})

const bubbleText = computed(() => {
  if (agent.proactiveMessage) return agent.proactiveMessage
  if (agent.state === 'listening') return '我在听。'
  if (agent.state === 'thinking') return '让我看看…'
  if (agent.state === 'error' && agent.error) return agent.error
  if (chat.chatBubble.visible) return chat.chatBubble.text
  return ''
})
const anchorStyle = computed(() => {
  const defaultControlsWidth = Math.max(260, Math.min(320, viewportWidth.value - 24))
  const composerExtras = (currentProfile.value.riskNotice ? 30 : 0)
    + (composerHeight.value - CHAT_COMPOSER_MIN_HEIGHT)
    + (followUpTarget.value ? 50 : 0)
    + (pendingAttachments.value.length ? 48 : 0)
    + (props.screenshotPreview ? 58 : 0)
    + (attachmentError.value ? 20 : 0)
  const defaultConversationHeight = Math.max(180, Math.min(360, viewportHeight.value - 110 - composerExtras))
  const defaultControlsHeight = 64
    + composerExtras
    + defaultConversationHeight
  const controlsWidth = Math.max(
    Math.min(MIN_CONTROLS_WIDTH, viewportWidth.value - 24),
    Math.min(controlsSize.value?.width ?? defaultControlsWidth, viewportWidth.value - 24),
  )
  const controlsHeight = Math.max(
    Math.min(MIN_CONTROLS_HEIGHT, viewportHeight.value - 24),
    Math.min(controlsSize.value?.height ?? defaultControlsHeight, viewportHeight.value - 24),
  )
  const controls = resolveSurfacePosition(
    controlsOffset.value,
    surfacePosition(controlsWidth, controlsHeight),
    controlsWidth,
    controlsHeight,
  )
  const bubble = surfacePosition(280, 150)
  return {
    '--controls-right': `${Math.max(12, viewportWidth.value - controls.left - controlsWidth)}px`,
    '--controls-bottom': `${Math.max(12, viewportHeight.value - controls.top - controlsHeight)}px`,
    '--controls-width': `${controlsWidth}px`,
    '--controls-height': `${controlsHeight}px`,
    '--composer-height': `${composerHeight.value}px`,
    '--bubble-left': `${bubble.left}px`,
    '--bubble-top': `${bubble.top}px`,
  }
})

function startSurfaceDrag(event: PointerEvent) {
  if (event.button !== 0 || resizingSurface.value) return
  if (event.target instanceof Element && event.target.closest('button, input, textarea, select, a')) return
  const element = controlsRef.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  draggingSurface.value = true
  dragPointerId = event.pointerId
  dragOffsetX = event.clientX - rect.left
  dragOffsetY = event.clientY - rect.top
  event.preventDefault()
  event.stopPropagation()
}

function startSurfaceResize(event: PointerEvent, axis: 'width' | 'height' | 'both') {
  if (event.button !== 0 || draggingSurface.value) return
  const element = controlsRef.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  resizingSurface.value = true
  resizePointerId = event.pointerId
  resizeStartX = event.clientX
  resizeStartY = event.clientY
  resizeStartWidth = rect.width
  resizeStartHeight = rect.height
  resizeStartLeft = rect.left
  resizeStartBottom = rect.bottom
  resizeAxis = axis
  if (event.currentTarget instanceof Element) event.currentTarget.setPointerCapture?.(event.pointerId)
  event.stopPropagation()
}

function onSurfaceResizeMove(event: PointerEvent) {
  if (!resizingSurface.value || event.pointerId !== resizePointerId) return
  const nextSize = clampPetSurfaceSize({
    width: resizeAxis === 'height'
      ? resizeStartWidth
      : resizeStartWidth + event.clientX - resizeStartX,
    height: resizeAxis === 'width'
      ? resizeStartHeight
      : resizeStartHeight + resizeStartY - event.clientY,
    left: resizeStartLeft,
    top: 0,
    viewportWidth: viewportWidth.value,
    viewportHeight: viewportHeight.value,
    minWidth: MIN_CONTROLS_WIDTH,
    minHeight: MIN_CONTROLS_HEIGHT,
    maxHeight: resizeStartBottom - 12,
  })
  controlsSize.value = nextSize
  const automatic = surfacePosition(nextSize.width, nextSize.height)
  const anchored = clampPetSurfacePosition({
    left: resizeStartLeft,
    top: resizeStartBottom - nextSize.height,
    viewportWidth: viewportWidth.value,
    viewportHeight: viewportHeight.value,
    surfaceWidth: nextSize.width,
    surfaceHeight: nextSize.height,
  })
  controlsOffset.value = {
    x: anchored.left - automatic.left,
    y: anchored.top - automatic.top,
  }
  event.preventDefault()
}

function stopSurfaceResize(event: PointerEvent) {
  if (!resizingSurface.value || event.pointerId !== resizePointerId) return
  resizingSurface.value = false
  resizePointerId = -1
  persistControlsSize()
}

function onSurfacePointerMove(event: PointerEvent) {
  if (!draggingSurface.value || event.pointerId !== dragPointerId) return
  const element = controlsRef.value
  if (!element) return
  const next = clampPetSurfacePosition({
    left: event.clientX - dragOffsetX,
    top: event.clientY - dragOffsetY,
    viewportWidth: viewportWidth.value,
    viewportHeight: viewportHeight.value,
    surfaceWidth: element.offsetWidth,
    surfaceHeight: element.offsetHeight,
  })
  const automatic = surfacePosition(element.offsetWidth, element.offsetHeight)
  const offset = {
    x: next.left - automatic.left,
    y: next.top - automatic.top,
  }
  controlsOffset.value = offset
  event.preventDefault()
}

function stopSurfaceDrag(event: PointerEvent) {
  if (!draggingSurface.value || event.pointerId !== dragPointerId) return
  draggingSurface.value = false
  dragPointerId = -1
}

function submit() {
  const value = draftText.value.trim()
  if ((!value && !pendingAttachments.value.length) || workspaceBusy.value) return
  emit('submit', {
    text: value,
    attachments: [...pendingAttachments.value],
    ...(followUpTarget.value ? { replyTo: followUpTarget.value } : {}),
  })
  chat.clearDraft(agent.currentRole)
  followUpTarget.value = undefined
  pendingAttachments.value = []
  attachmentError.value = ''
  if (fileInputRef.value) fileInputRef.value.value = ''
  void nextTick(resizeComposer)
}

function closeChat() {
  roleMenuOpen.value = false
  attachmentMenuOpen.value = false
  sessionDrawerOpen.value = false
  followUpTarget.value = undefined
  emit('cancel-screenshot')
  chat.hideChatBubble()
  agent.chatOpen = false
}

async function selectRole(roleId: RoleId) {
  if (workspaceBusy.value) return
  agent.currentRole = roleId
  roleMenuOpen.value = false
  attachmentMenuOpen.value = false
  sessionDrawerOpen.value = false
  await nextTick()
  messageListRef.value?.scrollToBottom()
  await focusComposer()
}

function toggleRoleMenu() {
  if (workspaceBusy.value) return
  roleMenuOpen.value = !roleMenuOpen.value
  attachmentMenuOpen.value = false
  sessionDrawerOpen.value = false
}

function toggleSessionDrawer() {
  sessionDrawerOpen.value = !sessionDrawerOpen.value
  roleMenuOpen.value = false
  attachmentMenuOpen.value = false
}

async function createConversation() {
  if (workspaceBusy.value) return
  chat.createConversation(agent.currentRole)
  roleMenuOpen.value = false
  attachmentMenuOpen.value = false
  sessionDrawerOpen.value = false
  followUpTarget.value = undefined
  await focusComposer()
}
async function continueQuestion(reference: ChatReplyReference) {
  followUpTarget.value = reference
  sessionDrawerOpen.value = false
  await focusComposer()
}

function clearFollowUp() {
  followUpTarget.value = undefined
  void focusComposer()
}

function openFilePicker() {
  attachmentMenuOpen.value = false
  attachmentError.value = ''
  fileInputRef.value?.click()
}

function toggleAttachmentMenu() {
  if (workspaceBusy.value) return
  attachmentMenuOpen.value = !attachmentMenuOpen.value
  roleMenuOpen.value = false
  sessionDrawerOpen.value = false
}

function captureCurrentScreen() {
  attachmentMenuOpen.value = false
  emit('capture-screen')
}

function closeAttachmentMenu() {
  if (!attachmentMenuOpen.value) return
  attachmentMenuOpen.value = false
}

function onFileSelected(event: Event) {
  closeAttachmentMenu()
  const files = Array.from((event.target as HTMLInputElement).files || [])
  for (const file of files) {
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!extension || !['pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'heic', 'webp', 'tif', 'tiff', 'txt', 'md', 'markdown', 'json', 'csv', 'log'].includes(extension)) {
      attachmentError.value = '目前支持 PDF、DOCX、XLSX、图片、TXT、Markdown、JSON 和 CSV 文件'
      continue
    }
    if (file.size > 12 * 1024 * 1024) {
      attachmentError.value = '单个附件不能超过 12MB'
      continue
    }
    if (pendingAttachments.value.some((item) => attachmentKey(item) === attachmentKey(file))) continue
    if (pendingAttachments.value.length >= 3) {
      attachmentError.value = '一次最多添加 3 个附件'
      break
    }
    pendingAttachments.value.push(file)
  }
  if (fileInputRef.value) fileInputRef.value.value = ''
}

function removeAttachment(file: File) {
  pendingAttachments.value = pendingAttachments.value.filter((item) => attachmentKey(item) !== attachmentKey(file))
  attachmentError.value = ''
}

function attachmentKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

</script>

<style scoped>
.pet-interaction { position: absolute; inset: 0; pointer-events: none; z-index: 30; }
.pet-bubble,
.interaction-controls { position: absolute; pointer-events: auto; -webkit-app-region: no-drag; }
.pet-bubble {
  left: var(--bubble-left);
  top: var(--bubble-top);
  width: 260px; padding: 12px 14px; color: #293548; background: rgba(252, 252, 250, 0.95);
  border: 1px solid rgba(46, 61, 84, 0.16); border-radius: 8px; box-shadow: 0 8px 28px rgba(25,34,48,0.16);
  backdrop-filter: blur(14px);
}
.pet-bubble p { margin: 5px 0 0; font-size: 13px; line-height: 1.55; white-space: pre-wrap; }
.state-line { display: flex; align-items: center; gap: 6px; color: #5c6980; font-size: 12px; }
.state-dot { width: 6px; height: 6px; border-radius: 50%; background: #b85b65; }
.inline-command { display: inline-flex; align-items: center; gap: 5px; margin-top: 8px; padding: 4px 7px; border: 0; color: #9f3434; background: transparent; cursor: pointer; }
.interaction-controls {
  right: var(--controls-right);
  bottom: var(--controls-bottom);
  container-type: inline-size;
  box-sizing: border-box; width: var(--controls-width); height: var(--controls-height); padding: 6px; display: flex; flex-direction: column; overflow: hidden;
  background: rgba(250,250,248,0.97); border: 1px solid rgba(46,61,84,0.16); border-radius: 8px;
  box-shadow: 0 8px 26px rgba(25,34,48,0.16); backdrop-filter: blur(16px);
  transition: width .18s ease, height .2s ease;
}
.interaction-controls.dragging { transition: none; }
.interaction-controls.resizing { transition: none; user-select: none; }
.panel-resize-edge, .panel-resize-corner { position: absolute; z-index: 6; touch-action: none; }
.panel-resize-edge.top { top: 0; left: 10px; right: 10px; height: 4px; cursor: ns-resize; }
.panel-resize-edge.right { top: 12px; right: 0; bottom: 12px; width: 5px; cursor: ew-resize; }
.panel-resize-corner { top: 0; right: 0; width: 14px; height: 14px; cursor: nesw-resize; }
.input-row { height: calc(var(--composer-height) + 6px); min-height: 40px; max-height: 78px; flex: none; box-sizing: border-box; padding: 6px 2px 0; display: flex; align-items: flex-end; gap: 4px; border-top: 1px solid #e2e6ec; }
.input-row textarea { min-width: 0; height: var(--composer-height); min-height: 34px; max-height: 72px; flex: 1 1 auto; box-sizing: border-box; resize: none; border: 0; border-radius: 6px; padding: 8px 10px; color: #293548; background: #f1f4f8; outline: none; font-family: inherit; font-size: 13px; line-height: 19px; overflow-y: auto; }
.input-row textarea:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px #7b96bb; }
.file-input { display: none; }
.role-menu { position: absolute; z-index: 4; top: 45px; left: 10px; right: 10px; padding: 5px; display: grid; gap: 3px; border: 1px solid #dce1e9; border-radius: 6px; background: rgba(246,247,249,.98); box-shadow: 0 8px 20px rgba(25,34,48,.12); }
.role-menu button { height: 31px; padding: 0 8px; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 5px; color: #40516c; background: transparent; cursor: pointer; }
.role-menu button:hover, .role-menu button.selected { background: #e9edf3; }
.role-menu button span { flex: 1; text-align: left; }
.attachment-menu { position: absolute; z-index: 4; left: 8px; bottom: 49px; width: 174px; padding: 5px; display: grid; gap: 3px; border: 1px solid #dce1e9; border-radius: 6px; background: rgba(246,247,249,.98); box-shadow: 0 8px 20px rgba(25,34,48,.12); }
.attachment-menu button { height: 32px; padding: 0 9px; display: flex; align-items: center; gap: 9px; border: 0; border-radius: 5px; color: #40516c; background: transparent; cursor: pointer; }
.attachment-menu button:hover { background: #e9edf3; }
.attachment-menu button:disabled { opacity: .4; cursor: default; }
.attachment-menu button span { flex: 1; text-align: left; font-size: 12px; }
.risk-notice { flex: none; margin: 4px 4px 0; color: #8c6570; font-size: 11px; line-height: 1.4; }
.icon-button { width: 36px; height: 34px; flex: none; display: grid; place-items: center; border: 0; border-radius: 6px; color: #40516c; background: transparent; cursor: pointer; }
.icon-button.compact { width: 30px; height: 30px; }
.icon-button:hover { background: #e9edf3; }
.icon-button.active { color: #fff; background: #5577a7; }
.icon-button:disabled { opacity: 0.35; cursor: default; }
.icon-button.accent { color: #fff; background: #5577a7; }
.icon-button.danger { color: #a74650; }
.icon-button.recording { color: #fff; background: #b85b65; animation: record-pulse 1s ease-in-out infinite; }
.conversation-section { min-height: 180px; flex: 1 1 auto; display: flex; flex-direction: column; overflow: hidden; }
.chat-header { min-height: 44px; flex: none; padding: 4px 0 0 4px; display: flex; align-items: center; justify-content: space-between; color: #293548; cursor: grab; touch-action: none; }
.interaction-controls.dragging .chat-header { cursor: grabbing; }
.chat-header button { cursor: pointer; touch-action: auto; }
.header-leading { min-width: 0; display: flex; align-items: center; gap: 1px; }
.role-switcher { min-width: 0; height: 32px; padding: 0 7px; display: flex; align-items: center; gap: 6px; border: 0; border-radius: 6px; color: #293548; background: transparent; cursor: pointer; }
.role-switcher:hover { background: #e9edf3; }
.role-switcher span { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 650; }
.header-actions { min-width: 0; display: flex; align-items: center; gap: 2px; }
.agent-state { min-width: 0; max-width: 100px; display: flex; align-items: center; gap: 5px; overflow: hidden; color: #738095; font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.followup-context { flex: none; height: 46px; margin: 4px 2px 0; padding: 0 6px 0 8px; box-sizing: border-box; display: flex; align-items: center; gap: 7px; border: 1px solid #cfd9e7; border-radius: 6px; color: #526986; background: #eef2f7; }
.followup-context > svg { flex: none; }
.followup-context > span { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.followup-context small { overflow: hidden; color: #6f7d90; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.followup-context button { width: 24px; height: 24px; flex: none; display: grid; place-items: center; border: 0; border-radius: 4px; color: #718095; background: transparent; cursor: pointer; }
.followup-context button:hover { background: #dde4ed; }
.attachment-preview { min-width: 0; flex: none; height: 44px; margin: 4px 2px 0; display: flex; gap: 4px; overflow-x: auto; }
.attachment-item { width: 145px; height: 40px; flex: 0 0 145px; padding: 0 5px 0 7px; box-sizing: border-box; display: flex; align-items: center; gap: 6px; border: 1px solid #dce1e8; border-radius: 6px; color: #42536c; background: #f3f5f8; }
.attachment-item > span { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.attachment-item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; }
.attachment-item small { color: #7f8998; font-size: 10px; }
.attachment-item button { width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 4px; color: #778395; background: transparent; cursor: pointer; }
.attachment-item button:hover { background: #e2e6ec; }
.screenshot-preview { min-width: 0; flex: none; height: 54px; margin: 4px 2px 0; padding: 4px; box-sizing: border-box; display: flex; align-items: center; gap: 6px; border: 1px solid #dce1e8; border-radius: 6px; color: #42536c; background: #f3f5f8; }
.screenshot-preview img { width: 62px; height: 44px; flex: none; object-fit: cover; border-radius: 4px; background: #e2e6ec; }
.screenshot-preview span { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.screenshot-preview strong { font-size: 11px; font-weight: 600; }
.screenshot-preview small { color: #748094; font-size: 10px; }
.screenshot-preview button { width: 25px; height: 25px; flex: none; display: grid; place-items: center; border: 0; border-radius: 4px; color: #778395; background: transparent; cursor: pointer; }
.screenshot-preview button:hover { background: #e2e6ec; }
.screenshot-preview button.confirm { color: #fff; background: #5577a7; }
.attachment-error { flex: none; margin: 3px 6px 0; color: #a74650; font-size: 11px; }
button:focus-visible, input:focus-visible { outline: 2px solid #6f8fbc; outline-offset: 2px; }
@container (max-width: 360px) { .agent-state { display: none; } .role-switcher span { max-width: 92px; } }
.bubble-pop-enter-active, .bubble-pop-leave-active, .toolbar-pop-enter-active, .toolbar-pop-leave-active { transition: opacity .18s ease, transform .18s ease; }
.bubble-pop-enter-from, .bubble-pop-leave-to, .toolbar-pop-enter-from, .toolbar-pop-leave-to { opacity: 0; transform: translateY(6px); }
@keyframes record-pulse { 50% { transform: scale(.92); } }
</style>
