<template>
  <div ref="listRef" class="message-list" aria-live="polite" aria-label="对话记录">
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
        <div
          v-if="message.role === 'assistant' && !message.streaming"
          class="message-markdown"
          @click="handleMarkdownClick"
          v-html="renderSafeMarkdown(message.text)"
        ></div>
        <span v-else class="message-text">{{ message.text }}</span>
        <div v-if="message.attachments?.length" class="sent-attachments">
          <span v-for="attachment in message.attachments" :key="attachment.id">
            <FileText :size="12" /> {{ attachment.name }}
          </span>
        </div>
        <div v-if="!message.streaming" class="message-actions">
          <button
            v-if="message.role === 'assistant' && message.truncated"
            type="button"
            title="继续生成"
            :disabled="workspaceBusy"
            @click="$emit('continue-generation', message.id)"
          >
            <MessageCircleMore :size="13" /><span>继续生成</span>
          </button>
          <button
            type="button"
            :title="copiedMessageId === message.id ? '已复制' : message.role === 'user' ? '复制问题' : '复制回答'"
            @click="copyMessage(message.id, message.text)"
          >
            <Check v-if="copiedMessageId === message.id" :size="13" />
            <Copy v-else :size="13" />
          </button>
          <button
            v-if="message.role === 'assistant' && chat.canRetryRequest(message.id)"
            type="button"
            title="重新生成"
            :disabled="workspaceBusy"
            @click="$emit('retry', message.id)"
          >
            <RotateCcw :size="13" />
          </button>
          <button
            v-if="message.role === 'assistant'"
            type="button"
            title="继续追问"
            @click="continueQuestion(message.id, message.text)"
          >
            <MessageCircleMore :size="13" /><span>追问</span>
          </button>
        </div>
      </template>
    </div>
    <div
      v-if="waitingForFirstToken"
      class="message assistant generation-placeholder"
      role="status"
      :aria-label="waitingLabel"
    >
      <span>{{ waitingLabel }}</span>
      <span class="generation-dots" aria-hidden="true"><i /><i /><i /></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import {
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileText,
  MessageCircleMore,
  Reply,
  RotateCcw,
} from 'lucide-vue-next'
import { useAgentStore } from '@/stores/agent'
import { useChatStore, type ChatReplyReference } from '@/stores/chat'
import { renderSafeMarkdown } from '@/services/markdown'

defineProps<{
  followUpTarget?: ChatReplyReference
  workspaceBusy: boolean
}>()

const emit = defineEmits<{
  retry: [requestId: string]
  'continue-generation': [requestId: string]
  'continue-question': [reference: ChatReplyReference]
}>()

const agent = useAgentStore()
const chat = useChatStore()
const listRef = ref<HTMLElement>()
const copiedMessageId = ref('')
const responseStarted = computed(() => chat.messages.some((message) => (
  (message.type === 'text' && message.role === 'assistant' && message.id === agent.activeRequestId)
  || (message.type === 'thought' && message.requestId === agent.activeRequestId)
  || (message.type === 'market' && message.requestId === agent.activeRequestId)
  || (message.type === 'status' && message.requestId === agent.activeRequestId)
)))
const waitingForFirstToken = computed(() => (
  ['thinking', 'planning', 'executing', 'speaking'].includes(agent.state)
  && agent.interruptible
  && !responseStarted.value
))
const waitingLabel = computed(() => agent.state === 'speaking' ? '正在组织回答' : '正在理解问题')
let copiedTimer: ReturnType<typeof setTimeout> | null = null

onUnmounted(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})

function isNearBottom(): boolean {
  const list = listRef.value
  return !list || list.scrollHeight - list.scrollTop - list.clientHeight < 56
}

function scrollToBottom(): void {
  const list = listRef.value
  if (list) list.scrollTop = list.scrollHeight
}

async function copyMessage(messageId: string, text: string): Promise<void> {
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

function handleMarkdownClick(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target.closest('a') : null
  if (!(target instanceof HTMLAnchorElement)) return
  event.preventDefault()
  try {
    const url = new URL(target.href)
    if (['http:', 'https:'].includes(url.protocol)) void window.electronAPI?.openNativeUrl(url.toString())
  } catch { /* markdown renderer already sanitizes links */ }
}

function continueQuestion(messageId: string, text: string): void {
  const preview = text.replace(/\s+/g, ' ').trim()
  emit('continue-question', {
    messageId,
    preview: preview.length > 96 ? `${preview.slice(0, 96)}…` : preview,
  })
}

function formatPrice(value: number | null): string {
  return value == null ? '--' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
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

defineExpose({ isNearBottom, scrollToBottom })
</script>

<style scoped>
.message-list { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.message { max-width: 88%; padding: 8px 10px; border-radius: 7px; font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.message.user { position: relative; align-self: flex-end; color: #fff; background: #425d82; }
.message.assistant { align-self: flex-start; background: #edf0f5; }
.generation-placeholder { min-width: 112px; display: flex; align-items: center; gap: 8px; color: #748196; }
.generation-dots { display: inline-flex; align-items: center; gap: 3px; }
.generation-dots i { width: 4px; height: 4px; border-radius: 50%; background: #8c99aa; animation: generation-pulse 1.1s ease-in-out infinite; }
.generation-dots i:nth-child(2) { animation-delay: .15s; }
.generation-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes generation-pulse { 0%, 70%, 100% { opacity: .3; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-2px); } }
.message.assistant.followup-target { box-shadow: 0 0 0 2px rgba(85,119,167,.38); }
.message.thought { width: 100%; max-width: 100%; box-sizing: border-box; padding: 2px 0 8px; color: #8791a2; background: transparent; border-bottom: 1px solid #e4e7ec; }
.message.status { width: 100%; max-width: 100%; box-sizing: border-box; color: #7f3f49; background: #fff4f3; border: 1px solid #efcfcc; }
.status-message-copy { display: flex; align-items: flex-start; gap: 7px; }
.status-message-copy svg { flex: none; margin-top: 1px; }
.retry-button { margin: 7px 0 0 22px; padding: 4px 8px; display: inline-flex; align-items: center; gap: 5px; border: 1px solid #dbaeb0; border-radius: 5px; color: #914550; background: #fffafa; cursor: pointer; }
.retry-button:hover { background: #f9e8e7; }
.retry-button:disabled { opacity: .45; cursor: default; }
.thought-toggle { width: 100%; height: 28px; padding: 0 3px; display: flex; align-items: center; gap: 6px; border: 0; color: #7f8998; background: transparent; cursor: pointer; }
.thought-toggle span { flex: 1; text-align: left; font-size: 12px; }
.thought-steps { padding: 1px 5px 3px 23px; display: flex; flex-direction: column; gap: 5px; }
.thought-steps div { position: relative; color: #8d97a6; font-size: 12px; line-height: 1.5; }
.thought-steps div::before { content: ''; position: absolute; left: -12px; top: 6px; width: 4px; height: 4px; border-radius: 50%; background: #bdc4ce; }
.message img { max-width: 150px; display: block; }
.message-text { display: block; }
.message-markdown { display: block; max-width: 100%; overflow-x: auto; white-space: normal; }
.message-markdown :deep(p), .message-markdown :deep(ul), .message-markdown :deep(ol), .message-markdown :deep(blockquote), .message-markdown :deep(pre), .message-markdown :deep(table) { margin: 0 0 8px; }
.message-markdown :deep(:last-child) { margin-bottom: 0; }
.message-markdown :deep(h1), .message-markdown :deep(h2), .message-markdown :deep(h3), .message-markdown :deep(h4) { margin: 10px 0 5px; color: #293548; font-size: 13px; line-height: 1.4; }
.message-markdown :deep(ul), .message-markdown :deep(ol) { padding-left: 20px; }
.message-markdown :deep(blockquote) { padding-left: 8px; border-left: 2px solid #aeb9c8; color: #68778c; }
.message-markdown :deep(code) { padding: 1px 4px; border-radius: 3px; color: #344a68; background: #dde3ec; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.message-markdown :deep(pre) { max-width: 100%; padding: 8px; overflow-x: auto; border-radius: 5px; background: #dfe4eb; }
.message-markdown :deep(pre code) { padding: 0; color: #293548; background: transparent; white-space: pre; }
.message-markdown :deep(.hljs-keyword), .message-markdown :deep(.hljs-selector-tag), .message-markdown :deep(.hljs-literal) { color: #7d4d92; }
.message-markdown :deep(.hljs-string), .message-markdown :deep(.hljs-attr) { color: #2f705d; }
.message-markdown :deep(.hljs-number), .message-markdown :deep(.hljs-built_in) { color: #9a5c32; }
.message-markdown :deep(.hljs-comment) { color: #7c8795; font-style: italic; }
.message-markdown :deep(table) { width: 100%; border-collapse: collapse; font-size: 11px; }
.message-markdown :deep(th), .message-markdown :deep(td) { padding: 4px 6px; border: 1px solid #ced6e1; text-align: left; }
.message-markdown :deep(th) { background: #dfe5ed; }
.message-markdown :deep(a) { color: #3e679d; text-decoration: underline; cursor: pointer; }
.sent-reply-reference { max-width: 100%; margin-bottom: 5px; padding: 4px 6px; display: flex; align-items: center; gap: 5px; overflow: hidden; border-left: 2px solid rgba(255,255,255,.6); color: rgba(255,255,255,.82); background: rgba(255,255,255,.08); font-size: 11px; }
.sent-reply-reference svg { flex: none; }
.sent-reply-reference span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-actions { height: 24px; margin: 6px -3px -3px; display: flex; align-items: center; gap: 1px; opacity: .52; }
.message:hover .message-actions, .message-actions:focus-within { opacity: 1; }
.message-actions button { height: 26px; min-width: 26px; padding: 0 5px; display: inline-flex; align-items: center; justify-content: center; gap: 3px; border: 0; border-radius: 4px; color: #607087; background: transparent; cursor: pointer; font-size: 11px; }
.message-actions button:hover { background: #dfe4eb; }
.message-actions button:disabled { opacity: .35; cursor: default; }
.message.user .message-actions { position: absolute; right: calc(100% + 4px); bottom: 4px; height: 26px; margin: 0; opacity: .52; }
.message.user .message-actions button { color: #607087; }
.message.user .message-actions button:hover { background: #e4e8ee; }
.sent-attachments { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.sent-attachments span { max-width: 100%; padding: 4px 6px; display: flex; align-items: center; gap: 5px; overflow: hidden; border-radius: 4px; background: rgba(255,255,255,.15); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.message.market { width: 100%; max-width: 100%; box-sizing: border-box; padding: 9px; color: #293548; background: #f6f7f9; border: 1px solid #dde2e9; white-space: normal; }
.market-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.market-card-header > span { font-size: 12px; font-weight: 650; }
.market-card-header small { color: #7f8998; font-size: 11px; white-space: nowrap; }
.market-rows { margin-top: 7px; display: flex; flex-direction: column; }
.market-row { min-height: 31px; display: grid; grid-template-columns: minmax(0, 1fr) 66px 58px; align-items: center; gap: 6px; border-top: 1px solid #e4e7ec; }
.market-row:first-child { border-top: 0; }
.market-name { min-width: 0; display: flex; align-items: baseline; gap: 5px; overflow: hidden; }
.market-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.market-name code { flex: none; color: #7e8999; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
.market-price, .market-change { text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; }
.market-price { color: #34445b; font-weight: 650; }
.market-change.up { color: #c1474e; }
.market-change.down { color: #278064; }
.market-change.flat { color: #7c8796; }
.market-meta { padding-top: 5px; display: flex; flex-direction: column; gap: 2px; border-top: 1px solid #e4e7ec; color: #7f8998; font-size: 11px; line-height: 1.4; }
.empty { margin: auto; color: #8791a2; font-size: 12px; }
button:focus-visible { outline: 2px solid #6f8fbc; outline-offset: 2px; }
</style>
