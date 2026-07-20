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
        :class="{ dragging: draggingSurface }"
        data-pet-ui
        @mousedown.stop
      >
        <div class="panel-drag-handle" title="拖动对话面板" @pointerdown="startControlsDrag">
          <GripHorizontal :size="16" />
        </div>
        <section class="conversation-section">
          <header class="chat-header">
            <div class="header-leading">
              <button class="icon-button compact" type="button" title="会话记录" @click="toggleSessionDrawer">
                <PanelLeft :size="16" />
              </button>
              <button class="role-switcher" type="button" :disabled="agent.interruptible" @click="toggleRoleMenu">
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
                :disabled="agent.interruptible"
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
          <div v-if="sessionDrawerOpen" class="session-drawer">
            <div class="session-drawer-header">
              <strong>会话记录</strong>
              <button class="icon-button compact" type="button" title="关闭会话记录" @click="sessionDrawerOpen = false">
                <X :size="16" />
              </button>
            </div>
            <label class="session-search">
              <Search :size="14" />
              <input v-model="sessionQuery" placeholder="搜索标题或内容" />
              <button v-if="sessionQuery" type="button" title="清除搜索" @click="sessionQuery = ''">
                <X :size="13" />
              </button>
            </label>
            <button class="new-session-button" type="button" :disabled="agent.interruptible" @click="createConversation">
              <Plus :size="15" /> 新建会话
            </button>
            <div class="session-list">
              <div v-if="filteredConversations.length === 0" class="session-empty">没有匹配的会话</div>
              <div
                v-for="conversation in filteredConversations"
                :key="conversation.id"
                class="session-item"
                :class="{ active: conversation.id === chat.activeConversation.id }"
              >
                <button
                  class="session-main"
                  type="button"
                  :disabled="agent.interruptible"
                  @click="selectConversation(conversation.id)"
                >
                  <span>{{ conversation.title }}</span>
                  <small>{{ conversationTime(conversation.updatedAt) }}</small>
                </button>
                <div class="session-actions">
                  <button type="button" title="导出会话" @click="exportConversation(conversation.id)">
                    <Download :size="13" />
                  </button>
                  <button
                    type="button"
                    :title="pendingDeleteId === conversation.id ? '再次点击确认删除' : '删除会话'"
                    :disabled="agent.interruptible"
                    :class="{ confirm: pendingDeleteId === conversation.id }"
                    @click="deleteConversation(conversation.id)"
                  >
                    <Check v-if="pendingDeleteId === conversation.id" :size="13" />
                    <Trash2 v-else :size="13" />
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div ref="messageListRef" class="message-list">
            <div v-if="chat.messages.length === 0" class="empty">还没有对话</div>
            <div
              v-for="message in chat.messages"
              :key="message.id"
              :class="['message', message.role, message.type, { 'followup-target': followUpTarget?.messageId === message.id }]"
            >
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
              <template v-else-if="message.type === 'market'">
                <div class="market-card-header">
                  <span>{{ message.card.title }}</span>
                  <small v-if="message.card.asOf">{{ formatMarketTime(message.card.asOf) }}</small>
                </div>
                <div class="market-rows">
                  <div v-for="item in message.card.items" :key="`${item.code}-${item.name}`" class="market-row">
                    <div class="market-name">
                      <strong>{{ item.name }}</strong>
                      <code v-if="item.code">{{ item.code }}</code>
                    </div>
                    <span class="market-price">{{ formatPrice(item.price) }}</span>
                    <span :class="['market-change', changeClass(item.changePercent)]">{{ formatChange(item.changePercent) }}</span>
                  </div>
                </div>
                <div v-if="message.card.source || message.card.note" class="market-meta">
                  <span v-if="message.card.source">{{ message.card.source }}</span>
                  <span v-if="message.card.note">{{ message.card.note }}</span>
                </div>
              </template>
              <template v-else>
                <div v-if="message.replyTo" class="sent-reply-reference">
                  <Reply :size="11" />
                  <span>{{ message.replyTo.preview }}</span>
                </div>
                <span class="message-text">{{ message.text }}</span>
                <div v-if="message.attachments?.length" class="sent-attachments">
                  <span v-for="attachment in message.attachments" :key="attachment.id">
                    <FileText :size="12" /> {{ attachment.name }}
                  </span>
                </div>
                <div v-if="message.role === 'assistant' && !message.streaming" class="message-actions">
                  <button type="button" :title="copiedMessageId === message.id ? '已复制' : '复制回答'" @click="copyAnswer(message.id, message.text)">
                    <Check v-if="copiedMessageId === message.id" :size="13" />
                    <Copy v-else :size="13" />
                  </button>
                  <button
                    v-if="chat.getRequestText(message.id)"
                    type="button"
                    title="重新生成"
                    :disabled="agent.interruptible"
                    @click="$emit('retry', message.id)"
                  >
                    <RotateCcw :size="13" />
                  </button>
                  <button type="button" title="继续追问" @click="continueQuestion(message.id, message.text)">
                    <MessageCircleMore :size="13" /><span>追问</span>
                  </button>
                </div>
              </template>
            </div>
          </div>
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
        <p v-if="attachmentError" class="attachment-error">{{ attachmentError }}</p>
        <div class="input-row">
          <input ref="fileInputRef" class="file-input" type="file" accept=".pdf,.txt,.md,.markdown" multiple @change="onFileSelected" />
          <button class="icon-button" type="button" title="添加附件" :disabled="agent.interruptible || pendingAttachments.length >= 3" @click="openFilePicker">
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
            :disabled="agent.interruptible"
            @pointerdown.prevent="$emit('voice-start')"
            @pointerup.prevent="$emit('voice-stop')"
            @pointercancel="$emit('voice-stop')"
          >
            <Mic :size="18" />
          </button>
          <button class="icon-button accent" type="button" title="发送" :disabled="agent.interruptible || (!draftText.trim() && !pendingAttachments.length)" @click="submit">
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
  BrainCircuit,
  ChartCandlestick,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  FileText,
  GripHorizontal,
  MessageCircleMore,
  Mic,
  PanelLeft,
  Paperclip,
  Plus,
  Reply,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  SquarePen,
  Trash2,
  X,
} from 'lucide-vue-next'
import { useAgentStore } from '@/stores/agent'
import { useChatStore, type ChatReplyReference } from '@/stores/chat'
import { clampPetSurfacePosition, placePetSurface } from '@/services/interaction/pet-ui-position'
import { ROLE_IDS, ROLE_PROFILES, type RoleId } from '../../shared/roles'

const props = defineProps<{
  petX: number
  petY: number
  petWidth: number
  petHeight: number
}>()

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: File[]; replyTo?: ChatReplyReference }]
  'voice-start': []
  'voice-stop': []
  interrupt: []
  retry: [requestId: string]
  'chat-after-leave': []
}>()

const agent = useAgentStore()
const chat = useChatStore()
const roleMenuOpen = ref(false)
const sessionDrawerOpen = ref(false)
const sessionQuery = ref('')
const pendingDeleteId = ref('')
const copiedMessageId = ref('')
const followUpTarget = ref<ChatReplyReference>()
const pendingAttachments = ref<File[]>([])
const attachmentError = ref('')
const inputRef = ref<HTMLTextAreaElement>()
const fileInputRef = ref<HTMLInputElement>()
const composerHeight = ref(34)
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
let copiedTimer: ReturnType<typeof setTimeout> | null = null

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
  if (copiedTimer) clearTimeout(copiedTimer)
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
const filteredConversations = computed(() => {
  const query = sessionQuery.value.trim().toLocaleLowerCase()
  if (!query) return chat.conversations
  return chat.conversations.filter((conversation) => (
    conversation.title.toLocaleLowerCase().includes(query)
    || conversation.messages.some((message) => (
      message.type === 'text' && message.text.toLocaleLowerCase().includes(query)
    ))
  ))
})
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
  input.style.height = '0'
  composerHeight.value = Math.min(88, Math.max(34, input.scrollHeight))
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
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 56
  await nextTick()
  if (nearBottom) list.scrollTop = list.scrollHeight
})

watch(() => agent.chatOpen, async (open) => {
  if (!open) {
    roleMenuOpen.value = false
    sessionDrawerOpen.value = false
    pendingDeleteId.value = ''
    return
  }
  await nextTick()
  const list = messageListRef.value
  if (list) list.scrollTop = list.scrollHeight
  await focusComposer()
}, { flush: 'post', immediate: true })

watch(() => chat.activeConversation.id, async () => {
  pendingDeleteId.value = ''
  followUpTarget.value = undefined
  await nextTick()
  const list = messageListRef.value
  if (list) list.scrollTop = list.scrollHeight
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
  const controlsWidth = Math.max(260, Math.min(320, viewportWidth.value - 24))
  const composerExtras = (currentProfile.value.riskNotice ? 30 : 0)
    + (composerHeight.value - 34)
    + (followUpTarget.value ? 50 : 0)
    + (pendingAttachments.value.length ? 48 : 0)
    + (attachmentError.value ? 20 : 0)
  const conversationHeight = Math.max(180, Math.min(360, viewportHeight.value - 110 - composerExtras))
  const controlsHeight = 64
    + composerExtras
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
  if ((!value && !pendingAttachments.value.length) || agent.interruptible) return
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
  sessionDrawerOpen.value = false
  followUpTarget.value = undefined
  chat.hideChatBubble()
  agent.chatOpen = false
}

async function selectRole(roleId: RoleId) {
  if (agent.interruptible) return
  agent.currentRole = roleId
  roleMenuOpen.value = false
  sessionDrawerOpen.value = false
  await nextTick()
  const list = messageListRef.value
  if (list) list.scrollTop = list.scrollHeight
  await focusComposer()
}

function toggleRoleMenu() {
  if (agent.interruptible) return
  roleMenuOpen.value = !roleMenuOpen.value
  sessionDrawerOpen.value = false
  pendingDeleteId.value = ''
}

function toggleSessionDrawer() {
  sessionDrawerOpen.value = !sessionDrawerOpen.value
  roleMenuOpen.value = false
  pendingDeleteId.value = ''
}

async function createConversation() {
  if (agent.interruptible) return
  chat.createConversation(agent.currentRole)
  roleMenuOpen.value = false
  sessionDrawerOpen.value = false
  sessionQuery.value = ''
  followUpTarget.value = undefined
  await focusComposer()
}

async function selectConversation(conversationId: string) {
  if (agent.interruptible || !chat.setActiveConversation(conversationId, agent.currentRole)) return
  sessionDrawerOpen.value = false
  await focusComposer()
}

function deleteConversation(conversationId: string) {
  if (agent.interruptible) return
  if (pendingDeleteId.value !== conversationId) {
    pendingDeleteId.value = conversationId
    return
  }
  chat.deleteConversation(conversationId, agent.currentRole)
  pendingDeleteId.value = ''
}

async function exportConversation(conversationId: string) {
  const exported = chat.exportConversationMarkdown(conversationId)
  if (!exported) return
  await window.electronAPI?.exportConversation(exported)
}

function conversationTime(timestamp: number): string {
  const value = new Date(timestamp)
  const today = new Date()
  if (value.toDateString() === today.toDateString()) {
    return value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return value.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

async function copyAnswer(messageId: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const helper = document.createElement('textarea')
    helper.value = text
    helper.style.position = 'fixed'
    helper.style.opacity = '0'
    document.body.appendChild(helper)
    helper.select()
    document.execCommand('copy')
    helper.remove()
  }
  copiedMessageId.value = messageId
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copiedMessageId.value = '' }, 1600)
}

async function continueQuestion(messageId: string, text: string) {
  const preview = text.replace(/\s+/g, ' ').trim()
  followUpTarget.value = {
    messageId,
    preview: preview.length > 96 ? `${preview.slice(0, 96)}…` : preview,
  }
  sessionDrawerOpen.value = false
  await focusComposer()
}

function clearFollowUp() {
  followUpTarget.value = undefined
  void focusComposer()
}

function openFilePicker() {
  attachmentError.value = ''
  fileInputRef.value?.click()
}

function onFileSelected(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files || [])
  for (const file of files) {
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!extension || !['pdf', 'txt', 'md', 'markdown'].includes(extension)) {
      attachmentError.value = '目前支持 PDF、TXT 和 Markdown 文件'
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

function formatPrice(value: number | null): string {
  if (value == null) return '--'
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
}

function formatChange(value: number | null): string {
  if (value == null) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function changeClass(value: number | null): string {
  if (value == null || value === 0) return 'flat'
  return value > 0 ? 'up' : 'down'
}

function formatMarketTime(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 16)
  return parsed.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
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
.input-row { flex: none; min-height: 42px; padding: 6px 2px 0; display: flex; align-items: flex-end; gap: 4px; border-top: 1px solid #e2e6ec; }
.input-row textarea { min-width: 0; flex: 1; height: 34px; max-height: 88px; box-sizing: border-box; resize: none; border: 0; border-radius: 6px; padding: 8px 10px; color: #293548; background: #f1f4f8; outline: none; font-family: inherit; font-size: 12px; line-height: 18px; overflow-y: auto; }
.input-row textarea:focus { box-shadow: inset 0 0 0 1px #7b96bb; }
.file-input { display: none; }
.role-menu { position: absolute; z-index: 4; top: 45px; left: 10px; right: 10px; padding: 5px; display: grid; gap: 3px; border: 1px solid #dce1e9; border-radius: 6px; background: rgba(246,247,249,.98); box-shadow: 0 8px 20px rgba(25,34,48,.12); }
.role-menu button { height: 31px; padding: 0 8px; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 5px; color: #40516c; background: transparent; cursor: pointer; }
.role-menu button:hover, .role-menu button.selected { background: #e9edf3; }
.role-menu button span { flex: 1; text-align: left; }
.risk-notice { flex: none; margin: 4px 4px 0; color: #8c6570; font-size: 10px; line-height: 1.35; }
.icon-button { width: 36px; height: 34px; flex: none; display: grid; place-items: center; border: 0; border-radius: 6px; color: #40516c; background: transparent; cursor: pointer; }
.icon-button.compact { width: 30px; height: 30px; }
.icon-button:hover { background: #e9edf3; }
.icon-button.active { color: #fff; background: #5577a7; }
.icon-button:disabled { opacity: 0.35; cursor: default; }
.icon-button.accent { color: #fff; background: #5577a7; }
.icon-button.danger { color: #a74650; }
.icon-button.recording { color: #fff; background: #b85b65; animation: record-pulse 1s ease-in-out infinite; }
.conversation-section { flex: none; height: var(--conversation-height); display: flex; flex-direction: column; overflow: hidden; }
.chat-header { min-height: 44px; flex: none; padding: 7px 0 0 4px; display: flex; align-items: center; justify-content: space-between; color: #293548; }
.header-leading { min-width: 0; display: flex; align-items: center; gap: 1px; }
.role-switcher { min-width: 0; height: 32px; padding: 0 7px; display: flex; align-items: center; gap: 6px; border: 0; border-radius: 6px; color: #293548; background: transparent; cursor: pointer; }
.role-switcher:hover { background: #e9edf3; }
.role-switcher span { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 650; }
.header-actions { min-width: 0; display: flex; align-items: center; gap: 2px; }
.agent-state { max-width: 94px; display: flex; align-items: center; gap: 5px; overflow: hidden; color: #738095; font-size: 10px; white-space: nowrap; text-overflow: ellipsis; }
.message-list { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.message { max-width: 88%; padding: 7px 9px; border-radius: 7px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.message.user { align-self: flex-end; color: #fff; background: #425d82; }
.message.assistant { align-self: flex-start; background: #edf0f5; }
.message.assistant.followup-target { box-shadow: 0 0 0 2px rgba(85,119,167,.38); }
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
.message-text { display: block; }
.sent-reply-reference { max-width: 100%; margin-bottom: 5px; padding: 4px 6px; display: flex; align-items: center; gap: 5px; overflow: hidden; border-left: 2px solid rgba(255,255,255,.6); color: rgba(255,255,255,.76); background: rgba(255,255,255,.08); font-size: 9px; }
.sent-reply-reference svg { flex: none; }
.sent-reply-reference span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-actions { height: 24px; margin: 6px -3px -3px; display: flex; align-items: center; gap: 1px; opacity: .52; }
.message.assistant:hover .message-actions, .message-actions:focus-within { opacity: 1; }
.message-actions button { height: 24px; min-width: 24px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center; gap: 3px; border: 0; border-radius: 4px; color: #607087; background: transparent; cursor: pointer; font-size: 10px; }
.message-actions button:hover { background: #dfe4eb; }
.message-actions button:disabled { opacity: .35; cursor: default; }
.sent-attachments { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.sent-attachments span { max-width: 100%; padding: 4px 6px; display: flex; align-items: center; gap: 5px; overflow: hidden; border-radius: 4px; background: rgba(255,255,255,.15); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.message.market { width: 100%; max-width: 100%; box-sizing: border-box; padding: 9px; color: #293548; background: #f6f7f9; border: 1px solid #dde2e9; white-space: normal; }
.market-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.market-card-header > span { font-size: 11px; font-weight: 650; }
.market-card-header small { color: #8a94a4; font-size: 9px; white-space: nowrap; }
.market-rows { margin-top: 7px; display: flex; flex-direction: column; }
.market-row { min-height: 31px; display: grid; grid-template-columns: minmax(0, 1fr) 66px 58px; align-items: center; gap: 6px; border-top: 1px solid #e4e7ec; }
.market-row:first-child { border-top: 0; }
.market-name { min-width: 0; display: flex; align-items: baseline; gap: 5px; overflow: hidden; }
.market-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.market-name code { flex: none; color: #8791a2; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
.market-price, .market-change { text-align: right; font-variant-numeric: tabular-nums; font-size: 11px; }
.market-price { color: #34445b; font-weight: 650; }
.market-change.up { color: #c1474e; }
.market-change.down { color: #278064; }
.market-change.flat { color: #7c8796; }
.market-meta { padding-top: 5px; display: flex; flex-direction: column; gap: 2px; border-top: 1px solid #e4e7ec; color: #929aa7; font-size: 9px; line-height: 1.35; }
.followup-context { flex: none; height: 46px; margin: 4px 2px 0; padding: 0 6px 0 8px; box-sizing: border-box; display: flex; align-items: center; gap: 7px; border: 1px solid #cfd9e7; border-radius: 6px; color: #526986; background: #eef2f7; }
.followup-context > svg { flex: none; }
.followup-context > span { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
.followup-context small { overflow: hidden; color: #7d899a; font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.followup-context button { width: 24px; height: 24px; flex: none; display: grid; place-items: center; border: 0; border-radius: 4px; color: #718095; background: transparent; cursor: pointer; }
.followup-context button:hover { background: #dde4ed; }
.attachment-preview { min-width: 0; flex: none; height: 44px; margin: 4px 2px 0; display: flex; gap: 4px; overflow-x: auto; }
.attachment-item { width: 145px; height: 40px; flex: 0 0 145px; padding: 0 5px 0 7px; box-sizing: border-box; display: flex; align-items: center; gap: 6px; border: 1px solid #dce1e8; border-radius: 6px; color: #42536c; background: #f3f5f8; }
.attachment-item > span { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.attachment-item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 600; }
.attachment-item small { color: #929baa; font-size: 9px; }
.attachment-item button { width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 4px; color: #778395; background: transparent; cursor: pointer; }
.attachment-item button:hover { background: #e2e6ec; }
.attachment-error { flex: none; margin: 3px 6px 0; color: #a74650; font-size: 10px; }
.session-drawer { position: absolute; z-index: 3; top: 46px; left: 6px; right: 6px; height: calc(var(--conversation-height) - 50px); box-sizing: border-box; padding: 8px; display: flex; flex-direction: column; border: 1px solid #dce1e9; border-radius: 7px; background: rgba(250,250,248,.99); box-shadow: 0 8px 18px rgba(25,34,48,.11); }
.session-drawer-header { height: 28px; display: flex; align-items: center; justify-content: space-between; color: #34445b; }
.session-drawer-header strong { font-size: 12px; }
.session-search { height: 31px; margin-top: 3px; padding: 0 7px; display: flex; align-items: center; gap: 6px; border: 1px solid #dfe3e9; border-radius: 6px; color: #8691a1; background: #f4f5f7; }
.session-search input { min-width: 0; flex: 1; border: 0; outline: 0; color: #34445b; background: transparent; font-size: 10px; }
.session-search button { width: 20px; height: 20px; display: grid; place-items: center; border: 0; color: #8a94a4; background: transparent; cursor: pointer; }
.new-session-button { height: 31px; margin-top: 6px; display: flex; align-items: center; justify-content: center; gap: 5px; border: 1px dashed #b8c2d0; border-radius: 6px; color: #4d6587; background: #f8f9fa; cursor: pointer; font-size: 10px; }
.new-session-button:hover { background: #edf1f6; }
.new-session-button:disabled { opacity: .4; cursor: default; }
.session-list { min-height: 0; flex: 1; margin-top: 5px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.session-item { min-height: 45px; display: flex; align-items: stretch; border-radius: 6px; border: 1px solid transparent; }
.session-item:hover { background: #f1f3f6; }
.session-item.active { border-color: #cfd8e5; background: #e9edf3; }
.session-main { min-width: 0; flex: 1; padding: 6px 7px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px; border: 0; color: #3b4b62; background: transparent; cursor: pointer; }
.session-main span { max-width: 165px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.session-main small { color: #929baa; font-size: 9px; }
.session-main:disabled { cursor: default; }
.session-actions { flex: none; padding-right: 3px; display: flex; align-items: center; gap: 1px; opacity: 0; }
.session-item:hover .session-actions, .session-item.active .session-actions, .session-actions:focus-within { opacity: 1; }
.session-actions button { width: 25px; height: 25px; display: grid; place-items: center; border: 0; border-radius: 4px; color: #778395; background: transparent; cursor: pointer; }
.session-actions button:hover { background: #dce2ea; }
.session-actions button.confirm { color: #a74650; background: #f5dddf; }
.session-actions button:disabled { opacity: .35; cursor: default; }
.session-empty { margin: auto; color: #929baa; font-size: 10px; }
.empty { margin: auto; color: #8791a2; font-size: 12px; }
.bubble-pop-enter-active, .bubble-pop-leave-active, .toolbar-pop-enter-active, .toolbar-pop-leave-active { transition: opacity .18s ease, transform .18s ease; }
.bubble-pop-enter-from, .bubble-pop-leave-to, .toolbar-pop-enter-from, .toolbar-pop-leave-to { opacity: 0; transform: translateY(6px); }
@keyframes record-pulse { 50% { transform: scale(.92); } }
</style>
