<template>
  <div class="pet-interaction" :style="anchorStyle">
    <Transition name="bubble-pop">
      <div v-if="bubbleText && !agent.interactionOpen" class="pet-bubble" data-pet-ui @mousedown.stop>
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
        v-if="agent.interactionOpen"
        ref="controlsRef"
        class="interaction-controls"
        :class="{
          expanded: inputOpen || agent.conversationOpen || Boolean(inlineBubbleText),
          dragging: draggingSurface,
          'conversation-expanded': agent.conversationOpen,
        }"
        data-pet-ui
        @mousedown.stop
      >
        <div class="panel-drag-handle" title="拖动输入框" @pointerdown="startControlsDrag">
          <GripHorizontal :size="16" />
        </div>
        <section v-if="inlineBubbleText" class="agent-status-section">
          <div v-if="stateLabel" class="state-line">
            <span class="state-dot" />{{ stateLabel }}
          </div>
          <p>{{ inlineBubbleText }}</p>
        </section>
        <section v-if="agent.conversationOpen" class="conversation-section">
          <header>
            <span>对话</span>
            <button class="icon-button" type="button" title="收起对话" @click="agent.conversationOpen = false">
              <ChevronDown :size="17" />
            </button>
          </header>
          <div class="message-list">
            <div v-if="chat.messages.length === 0" class="empty">还没有对话</div>
            <div v-for="message in chat.messages" :key="message.id" :class="['message', message.role]">
              <img
                v-if="message.type === 'emoji'"
                :src="`data:image/png;base64,${message.base64}`"
                alt="AI 表情"
              />
              <span v-else>{{ message.text }}</span>
            </div>
          </div>
        </section>
        <div v-if="inputOpen" class="input-row">
          <input
            ref="inputRef"
            v-model="inputText"
            placeholder="说点什么..."
            @keydown.enter="submit"
          />
          <button class="icon-button accent" type="button" title="发送" :disabled="!inputText.trim()" @click="submit">
            <Send :size="17" />
          </button>
        </div>
        <div class="toolbar-row">
          <button class="icon-button" :class="{ active: inputOpen }" type="button" title="文字输入" @click="toggleInput">
            <Keyboard :size="18" />
          </button>
          <button
            class="icon-button"
            :class="{ recording: agent.recording }"
            type="button"
            title="按住说话"
            @pointerdown.prevent="$emit('voice-start')"
            @pointerup.prevent="$emit('voice-stop')"
            @pointercancel="$emit('voice-stop')"
          >
            <Mic :size="18" />
          </button>
          <button class="icon-button" :class="{ active: agent.conversationOpen }" type="button" title="对话记录" @click="agent.conversationOpen = !agent.conversationOpen">
            <MessagesSquare :size="18" />
          </button>
          <button
            v-if="agent.interruptible"
            class="icon-button danger"
            type="button"
            title="停止当前任务"
            @click="$emit('interrupt')"
          >
            <Square :size="17" />
          </button>
          <button class="icon-button close-control" type="button" title="收起" @click="agent.interactionOpen = false">
            <X :size="17" />
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ChevronDown, GripHorizontal, Keyboard, MessagesSquare, Mic, Send, Square, X } from 'lucide-vue-next'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'
import { clampPetSurfacePosition, placePetSurface } from '@/services/interaction/pet-ui-position'

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
}>()

const agent = useAgentStore()
const chat = useChatStore()
const inputOpen = ref(false)
const inputText = ref('')
const inputRef = ref<HTMLInputElement>()
const controlsRef = ref<HTMLDivElement>()
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
const bubbleText = computed(() => {
  if (agent.proactiveMessage) return agent.proactiveMessage
  if (agent.state === 'listening') return '我在听。'
  if (agent.state === 'thinking') return '让我看看…'
  if (agent.state === 'error' && agent.error) return agent.error
  if (chat.chatBubble.visible) return chat.chatBubble.text
  return ''
})
const inlineBubbleText = computed(() => (
  agent.interactionOpen && !agent.conversationOpen ? bubbleText.value : ''
))

const anchorStyle = computed(() => {
  const controlsWidth = inputOpen.value || agent.conversationOpen || inlineBubbleText.value
    ? Math.max(240, Math.min(320, viewportWidth.value - 24))
    : 176
  const conversationHeight = Math.max(220, Math.min(360, viewportHeight.value - 180))
  const controlsHeight = 58
    + (inputOpen.value ? 50 : 0)
    + (inlineBubbleText.value ? 80 : 0)
    + (agent.conversationOpen ? conversationHeight + 6 : 0)
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

async function toggleInput() {
  inputOpen.value = !inputOpen.value
  if (inputOpen.value) {
    await nextTick()
    inputRef.value?.focus()
  }
}

function submit() {
  const value = inputText.value.trim()
  if (!value) return
  emit('submit', value)
  inputText.value = ''
  inputOpen.value = false
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
  box-sizing: border-box; width: var(--controls-width); height: var(--controls-height); padding: 6px; display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden;
  background: rgba(250,250,248,0.97); border: 1px solid rgba(46,61,84,0.16); border-radius: 8px;
  box-shadow: 0 8px 26px rgba(25,34,48,0.16); backdrop-filter: blur(16px);
  transition: width .18s ease, height .2s ease;
}
.interaction-controls.dragging { transition: none; }
.panel-drag-handle { position: absolute; z-index: 2; top: 2px; left: 0; right: 0; height: 10px; display: grid; place-items: center; color: #9aa5b5; cursor: grab; touch-action: none; }
.panel-drag-handle:active, .interaction-controls.dragging .panel-drag-handle { cursor: grabbing; }
.toolbar-row, .input-row { flex: none; display: flex; align-items: center; gap: 5px; }
.toolbar-row { justify-content: flex-start; }
.input-row { margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid #e2e6ec; }
.input-row input { min-width: 0; flex: 1; height: 34px; border: 0; border-radius: 6px; padding: 0 10px; color: #293548; background: #f1f4f8; outline: none; }
.input-row input:focus { border-color: #5577a7; }
.icon-button { width: 36px; height: 34px; flex: none; display: grid; place-items: center; border: 0; border-radius: 6px; color: #40516c; background: transparent; cursor: pointer; }
.icon-button:hover { background: #e9edf3; }
.icon-button.active { color: #fff; background: #5577a7; }
.icon-button:disabled { opacity: 0.35; cursor: default; }
.icon-button.accent { color: #fff; background: #5577a7; }
.icon-button.danger { color: #a74650; }
.icon-button.recording { color: #fff; background: #b85b65; animation: record-pulse 1s ease-in-out infinite; }
.close-control { margin-left: auto; color: #69778b; }
.agent-status-section { flex: none; max-height: 80px; margin: 0 0 6px; padding: 10px 8px 12px; overflow: auto; color: #293548; border-bottom: 1px solid #dce1e9; }
.agent-status-section p { margin: 6px 0 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
.conversation-section { flex: none; height: var(--conversation-height); margin: 0 0 6px; display: flex; flex-direction: column; overflow: hidden; border-bottom: 1px solid #dce1e9; }
.conversation-section header { height: 40px; flex: none; padding: 0 0 0 8px; display: flex; align-items: center; justify-content: space-between; color: #293548; font-size: 13px; font-weight: 600; }
.message-list { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.message { max-width: 86%; padding: 7px 9px; border-radius: 7px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
.message.user { align-self: flex-end; color: #fff; background: #425d82; }
.message.assistant { align-self: flex-start; background: #edf0f5; }
.message img { max-width: 150px; display: block; }
.empty { margin: auto; color: #8791a2; font-size: 12px; }
.bubble-pop-enter-active, .bubble-pop-leave-active, .toolbar-pop-enter-active, .toolbar-pop-leave-active { transition: opacity .18s ease, transform .18s ease; }
.bubble-pop-enter-from, .bubble-pop-leave-to, .toolbar-pop-enter-from, .toolbar-pop-leave-to { opacity: 0; transform: translateY(6px); }
@keyframes record-pulse { 50% { transform: scale(.92); } }
</style>
