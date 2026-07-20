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

    <Transition name="toolbar-pop">
      <div
        v-if="agent.chatOpen"
        ref="controlsRef"
        class="interaction-controls expanded conversation-expanded"
        :class="{ dragging: draggingSurface }"
        data-pet-ui
        @mousedown.stop
      >
        <div class="panel-drag-handle" title="拖动对话面板" @pointerdown="startControlsDrag">
          <GripHorizontal :size="16" />
        </div>
        <section class="conversation-section">
          <header class="chat-header">
            <button class="role-switcher" type="button" @click="roleMenuOpen = !roleMenuOpen">
              <Sparkles v-if="agent.currentRole === 'default'" :size="15" />
              <ChartCandlestick v-else :size="15" />
              <span>{{ currentProfile.name }}</span>
              <ChevronDown :size="14" />
            </button>
            <div class="header-actions">
              <span v-if="activeStateLabel" class="agent-state"><span class="state-dot" />{{ activeStateLabel }}</span>
              <button
                v-if="agent.interruptible"
                class="icon-button danger"
                type="button"
                title="停止当前回答"
                @click="$emit('interrupt')"
              >
                <Square :size="15" />
              </button>
              <button class="icon-button" type="button" title="收起对话" @click="agent.chatOpen = false">
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
          <div ref="messageListRef" class="message-list">
            <div v-if="chat.messages.length === 0" class="empty">还没有对话</div>
            <div v-for="message in chat.messages" :key="message.id" :class="['message', message.role, message.type]">
              <template v-if="message.type === 'thought'">
                <button class="thought-toggle" type="button" @click="chat.toggleThought(message.requestId)">
                  <BrainCircuit :size="14" />
                  <span>{{ message.complete ? '分析记录' : '正在分析' }}</span>
                  <ChevronRight v-if="message.collapsed" :size="14" />
                  <ChevronDown v-else :size="14" />
                </button>
                <div v-show="!message.collapsed" class="thought-steps">
                  <div v-for="step in message.steps" :key="step.id">{{ step.text }}</div>
                </div>
              </template>
              <template v-else-if="message.type === 'status'">
                <div class="status-message-copy">
                  <CircleAlert :size="15" />
                  <span>{{ message.text }}</span>
                </div>
                <button
                  v-if="message.retryable"
                  class="retry-button"
                  type="button"
                  :disabled="agent.interruptible"
                  @click="$emit('retry', message.requestId)"
                >
                  <RotateCcw :size="13" /> 重试
                </button>
              </template>
              <img
                v-else-if="message.type === 'emoji'"
                :src="`data:image/png;base64,${message.base64}`"
                alt="AI 表情"
              />
              <span v-else>{{ message.text }}</span>
            </div>
          </div>
        </section>
        <p v-if="currentProfile.riskNotice" class="risk-notice">{{ currentProfile.riskNotice }}</p>
        <div class="input-row">
          <input
            ref="inputRef"
            v-model="draftText"
            placeholder="说点什么..."
            @keydown.enter.exact.prevent="submit"
          />
          <button
            class="icon-button"
            :class="{ recording: agent.recording }"
            type="button"
            title="按住说话"
            :disabled="agent.interruptible"
            @pointerdown.prevent="$emit('voice-start')"
            @pointerup.prevent="$emit('voice-stop')"
            @pointercancel="$emit('voice-stop')"
          >
            <Mic :size="18" />
          </button>
          <button class="icon-button accent" type="button" title="发送" :disabled="agent.interruptible || !draftText.trim()" @click="submit">
            <Send :size="17" />
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { BrainCircuit, ChartCandlestick, Check, ChevronDown, ChevronRight, CircleAlert, GripHorizontal, Mic, RotateCcw, Send, Sparkles, Square, X } from 'lucide-vue-next'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { clampPetSurfacePosition, placePetSurface } from '@/services/interaction/pet-ui-position'
import { ROLE_IDS, ROLE_PROFILES, type RoleId } from '../../shared/roles'

const props = defineProps<{
  petX: number
  petY: number
  petWidth: number
  petHeight: number
}>()

const emit = defineEmits<{
  submit: [text: string]
  'voice-start': []
  'voice-stop': []
  interrupt: []
  retry: [requestId: string]
}>()

const agent = useAgentStore()
const chat = useChatStore()
const roleMenuOpen = ref(false)
const inputRef = ref<HTMLInputElement>()
const controlsRef = ref<HTMLDivElement>()
const messageListRef = ref<HTMLElement>()
const viewportWidth = ref(window.innerWidth)
const viewportHeight = ref(window.innerHeight)
const controlsOffset = ref<{ x: number; y: number } | null>(null)
const draggingSurface = ref(false)
let dragPointerId = -1
let dragOffsetX = 0
let dragOffsetY = 0
let viewportObserver: ResizeObserver | null = null

function updateViewport() {
  viewportWidth.value = window.innerWidth
  viewportHeight.value = window.innerHeight
}

onMounted(() => {
  updateViewport()
  window.addEventListener('resize', updateViewport)
  viewportObserver = new ResizeObserver(updateViewport)
  viewportObserver.observe(document.documentElement)
  window.addEventListener('pointermove', onSurfacePointerMove)
  window.addEventListener('pointerup', stopSurfaceDrag)
  window.addEventListener('pointercancel', stopSurfaceDrag)
})
onUnmounted(() => {
  window.removeEventListener('resize', updateViewport)
  viewportObserver?.disconnect()
  viewportObserver = null
  window.removeEventListener('pointermove', onSurfacePointerMove)
  window.removeEventListener('pointerup', stopSurfaceDrag)
  window.removeEventListener('pointercancel', stopSurfaceDrag)
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
  ['idle', 'success'].includes(agent.state) ? '' : stateLabel.value
))
const currentProfile = computed(() => ROLE_PROFILES[agent.currentRole])
const roleOptions = ROLE_IDS.map((roleId) => ROLE_PROFILES[roleId])
const draftText = computed({
  get: () => chat.draftsByRole[agent.currentRole],
  set: (value: string) => chat.setDraft(agent.currentRole, value),
})
const messageActivity = computed(() => chat.messages.map((message) => (
  message.type === 'thought'
    ? `${message.id}:${message.steps.length}:${message.collapsed}`
    : `${message.id}:${message.type === 'text' ? message.text.length : 0}`
)).join('|'))

async function focusComposer() {
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  inputRef.value?.focus()
}

watch(messageActivity, async () => {
  const list = messageListRef.value
  if (!list || !agent.chatOpen) return
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 56
  await nextTick()
  if (nearBottom) list.scrollTop = list.scrollHeight
})

watch(() => agent.chatOpen, async (open) => {
  if (!open) {
    roleMenuOpen.value = false
    return
  }
  await nextTick()
  const list = messageListRef.value
  if (list) list.scrollTop = list.scrollHeight
  await focusComposer()
}, { flush: 'post', immediate: true })

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
  const controlsWidth = Math.max(260, Math.min(320, viewportWidth.value - 24))
  const conversationHeight = Math.max(220, Math.min(360, viewportHeight.value - 190))
  const controlsHeight = 64
    + (currentProfile.value.riskNotice ? 30 : 0)
    + conversationHeight
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
    '--conversation-height': `${conversationHeight}px`,
    '--bubble-left': `${bubble.left}px`,
    '--bubble-top': `${bubble.top}px`,
  }
})

function startSurfaceDrag(event: PointerEvent) {
  if (event.button !== 0) return
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

function startControlsDrag(event: PointerEvent) {
  startSurfaceDrag(event)
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
  if (!value || agent.interruptible) return
  emit('submit', value)
  chat.clearDraft(agent.currentRole)
}

async function selectRole(roleId: RoleId) {
  agent.currentRole = roleId
  roleMenuOpen.value = false
  await nextTick()
  const list = messageListRef.value
  if (list) list.scrollTop = list.scrollHeight
  await focusComposer()
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
.state-line { display: flex; align-items: center; gap: 6px; color: #5c6980; font-size: 11px; }
.state-dot { width: 6px; height: 6px; border-radius: 50%; background: #b85b65; }
.inline-command { display: inline-flex; align-items: center; gap: 5px; margin-top: 8px; padding: 4px 7px; border: 0; color: #9f3434; background: transparent; cursor: pointer; }
.interaction-controls {
  right: var(--controls-right);
  bottom: var(--controls-bottom);
  box-sizing: border-box; width: var(--controls-width); height: var(--controls-height); padding: 6px; display: flex; flex-direction: column; overflow: hidden;
  background: rgba(250,250,248,0.97); border: 1px solid rgba(46,61,84,0.16); border-radius: 8px;
  box-shadow: 0 8px 26px rgba(25,34,48,0.16); backdrop-filter: blur(16px);
  transition: width .18s ease, height .2s ease;
}
.interaction-controls.dragging { transition: none; }
.panel-drag-handle { position: absolute; z-index: 2; top: 2px; left: 0; right: 0; height: 10px; display: grid; place-items: center; color: #9aa5b5; cursor: grab; touch-action: none; }
.panel-drag-handle:active, .interaction-controls.dragging .panel-drag-handle { cursor: grabbing; }
.input-row { flex: none; min-height: 42px; padding: 6px 2px 0; display: flex; align-items: center; gap: 4px; border-top: 1px solid #e2e6ec; }
.input-row input { min-width: 0; flex: 1; height: 34px; border: 0; border-radius: 6px; padding: 0 10px; color: #293548; background: #f1f4f8; outline: none; }
.input-row input:focus { box-shadow: inset 0 0 0 1px #7b96bb; }
.role-menu { position: absolute; z-index: 4; top: 45px; left: 10px; right: 10px; padding: 5px; display: grid; gap: 3px; border: 1px solid #dce1e9; border-radius: 6px; background: rgba(246,247,249,.98); box-shadow: 0 8px 20px rgba(25,34,48,.12); }
.role-menu button { height: 31px; padding: 0 8px; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 5px; color: #40516c; background: transparent; cursor: pointer; }
.role-menu button:hover, .role-menu button.selected { background: #e9edf3; }
.role-menu button span { flex: 1; text-align: left; }
.risk-notice { flex: none; margin: 4px 4px 0; color: #8c6570; font-size: 10px; line-height: 1.35; }
.icon-button { width: 36px; height: 34px; flex: none; display: grid; place-items: center; border: 0; border-radius: 6px; color: #40516c; background: transparent; cursor: pointer; }
.icon-button:hover { background: #e9edf3; }
.icon-button.active { color: #fff; background: #5577a7; }
.icon-button:disabled { opacity: 0.35; cursor: default; }
.icon-button.accent { color: #fff; background: #5577a7; }
.icon-button.danger { color: #a74650; }
.icon-button.recording { color: #fff; background: #b85b65; animation: record-pulse 1s ease-in-out infinite; }
.conversation-section { flex: none; height: var(--conversation-height); display: flex; flex-direction: column; overflow: hidden; }
.chat-header { min-height: 44px; flex: none; padding: 7px 0 0 4px; display: flex; align-items: center; justify-content: space-between; color: #293548; }
.role-switcher { min-width: 0; height: 32px; padding: 0 7px; display: flex; align-items: center; gap: 6px; border: 0; border-radius: 6px; color: #293548; background: transparent; cursor: pointer; }
.role-switcher:hover { background: #e9edf3; }
.role-switcher span { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 650; }
.header-actions { min-width: 0; display: flex; align-items: center; gap: 2px; }
.agent-state { max-width: 94px; display: flex; align-items: center; gap: 5px; overflow: hidden; color: #738095; font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }
.message-list { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.message { max-width: 86%; padding: 7px 9px; border-radius: 7px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
.message.user { align-self: flex-end; color: #fff; background: #425d82; }
.message.assistant { align-self: flex-start; background: #edf0f5; }
.message.thought { width: 100%; max-width: 100%; box-sizing: border-box; padding: 2px 0 8px; color: #8791a2; background: transparent; border-bottom: 1px solid #e4e7ec; }
.message.status { width: 100%; max-width: 100%; box-sizing: border-box; color: #7f3f49; background: #fff4f3; border: 1px solid #efcfcc; }
.status-message-copy { display: flex; align-items: flex-start; gap: 7px; }
.status-message-copy svg { flex: none; margin-top: 1px; }
.retry-button { margin: 7px 0 0 22px; padding: 4px 8px; display: inline-flex; align-items: center; gap: 5px; border: 1px solid #dbaeb0; border-radius: 5px; color: #914550; background: #fffafa; cursor: pointer; }
.retry-button:hover { background: #f9e8e7; }
.retry-button:disabled { opacity: .45; cursor: default; }
.thought-toggle { width: 100%; height: 28px; padding: 0 3px; display: flex; align-items: center; gap: 6px; border: 0; color: #7f8998; background: transparent; cursor: pointer; }
.thought-toggle span { flex: 1; text-align: left; font-size: 11px; }
.thought-steps { padding: 1px 5px 3px 23px; display: flex; flex-direction: column; gap: 5px; }
.thought-steps div { position: relative; color: #9aa3b0; font-size: 11px; line-height: 1.45; }
.thought-steps div::before { content: ''; position: absolute; left: -12px; top: 6px; width: 4px; height: 4px; border-radius: 50%; background: #bdc4ce; }
.message img { max-width: 150px; display: block; }
.empty { margin: auto; color: #8791a2; font-size: 12px; }
.bubble-pop-enter-active, .bubble-pop-leave-active, .toolbar-pop-enter-active, .toolbar-pop-leave-active { transition: opacity .18s ease, transform .18s ease; }
.bubble-pop-enter-from, .bubble-pop-leave-to, .toolbar-pop-enter-from, .toolbar-pop-leave-to { opacity: 0; transform: translateY(6px); }
@keyframes record-pulse { 50% { transform: scale(.92); } }
</style>
