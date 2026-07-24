<template>
  <div class="session-drawer">
    <div class="session-drawer-header">
      <strong>会话记录</strong>
      <button class="icon-button compact" type="button" title="关闭会话记录" @click="$emit('close')">
        <X :size="16" />
      </button>
    </div>
    <label class="session-search">
      <Search :size="14" />
      <input v-model="query" placeholder="搜索标题或内容" />
      <button v-if="query" type="button" title="清除搜索" @click="query = ''">
        <X :size="13" />
      </button>
    </label>
    <button class="new-session-button" type="button" :disabled="workspaceBusy" @click="createConversation">
      <Plus :size="15" /> 新建会话
    </button>
    <p v-if="chat.storageNotice" class="session-warning">{{ chat.storageNotice }}</p>
    <div class="session-list">
      <div v-if="filteredConversations.length === 0" class="session-empty">
        {{ query.trim() ? '没有匹配的会话' : '暂无会话记录' }}
      </div>
      <div
        v-for="conversation in filteredConversations"
        :key="conversation.id"
        class="session-item"
        :class="{ active: conversation.id === chat.activeConversation.id }"
      >
        <button
          class="session-main"
          type="button"
          :disabled="workspaceBusy"
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
            :disabled="workspaceBusy"
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
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, Download, Plus, Search, Trash2, X } from 'lucide-vue-next'
import { useAgentStore } from '@/stores/agent'
import { useChatStore } from '@/stores/chat'

defineProps<{ workspaceBusy: boolean }>()

const emit = defineEmits<{
  close: []
  'focus-composer': []
}>()

const agent = useAgentStore()
const chat = useChatStore()
const query = ref('')
const pendingDeleteId = ref('')

const filteredConversations = computed(() => {
  const normalized = query.value.trim().toLocaleLowerCase()
  if (!normalized) return chat.conversations
  return chat.conversations.filter((conversation) => (
    conversation.title.toLocaleLowerCase().includes(normalized)
    || conversation.messages.some((message) => (
      message.type === 'text' && message.text.toLocaleLowerCase().includes(normalized)
    ))
  ))
})

watch(() => chat.activeConversation.id, () => {
  pendingDeleteId.value = ''
})

function createConversation(): void {
  chat.createConversation(agent.currentRole)
  query.value = ''
  emit('close')
  emit('focus-composer')
}

function selectConversation(conversationId: string): void {
  if (!chat.setActiveConversation(conversationId, agent.currentRole)) return
  emit('close')
  emit('focus-composer')
}

function deleteConversation(conversationId: string): void {
  if (pendingDeleteId.value !== conversationId) {
    pendingDeleteId.value = conversationId
    return
  }
  chat.deleteConversation(conversationId, agent.currentRole)
  pendingDeleteId.value = ''
}

async function exportConversation(conversationId: string): Promise<void> {
  const exported = chat.exportConversationMarkdown(conversationId)
  if (exported) await window.electronAPI?.exportConversation(exported)
}

function conversationTime(timestamp: number): string {
  const value = new Date(timestamp)
  const today = new Date()
  if (value.toDateString() === today.toDateString()) {
    return value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return value.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}
</script>

<style scoped>
.session-drawer { position: absolute; z-index: 3; top: 46px; left: 6px; right: 6px; height: calc(var(--conversation-height) - 50px); box-sizing: border-box; padding: 8px; display: flex; flex-direction: column; border: 1px solid #dce1e9; border-radius: 7px; background: rgba(250,250,248,.99); box-shadow: 0 8px 18px rgba(25,34,48,.11); }
.session-drawer-header { height: 28px; display: flex; align-items: center; justify-content: space-between; color: #34445b; }
.session-drawer-header strong { font-size: 12px; }
.icon-button { width: 36px; height: 34px; flex: none; display: grid; place-items: center; border: 0; border-radius: 6px; color: #40516c; background: transparent; cursor: pointer; }
.icon-button.compact { width: 30px; height: 30px; }
.icon-button:hover { background: #e9edf3; }
.session-search { height: 31px; margin-top: 3px; padding: 0 7px; display: flex; align-items: center; gap: 6px; border: 1px solid #dfe3e9; border-radius: 6px; color: #8691a1; background: #f4f5f7; }
.session-search input { min-width: 0; flex: 1; border: 0; outline: 0; color: #34445b; background: transparent; font-size: 12px; }
.session-search button { width: 20px; height: 20px; display: grid; place-items: center; border: 0; color: #8a94a4; background: transparent; cursor: pointer; }
.new-session-button { height: 33px; margin-top: 6px; display: flex; align-items: center; justify-content: center; gap: 5px; border: 1px dashed #b8c2d0; border-radius: 6px; color: #4d6587; background: #f8f9fa; cursor: pointer; font-size: 12px; }
.new-session-button:hover { background: #edf1f6; }
.new-session-button:disabled { opacity: .4; cursor: default; }
.session-warning { margin: 6px 2px 0; color: #9b5963; font-size: 11px; line-height: 1.45; }
.session-list { min-height: 0; flex: 1; margin-top: 5px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.session-item { min-height: 45px; display: flex; align-items: stretch; border-radius: 6px; border: 1px solid transparent; }
.session-item:hover { background: #f1f3f6; }
.session-item.active { border-color: #cfd8e5; background: #e9edf3; }
.session-main { min-width: 0; flex: 1; padding: 6px 7px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px; border: 0; color: #3b4b62; background: transparent; cursor: pointer; }
.session-main span { max-width: 165px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.session-main small { color: #7f8998; font-size: 10px; }
.session-main:disabled { cursor: default; }
.session-actions { flex: none; padding-right: 3px; display: flex; align-items: center; gap: 1px; opacity: 0; }
.session-item:hover .session-actions, .session-item.active .session-actions, .session-actions:focus-within { opacity: 1; }
.session-actions button { width: 25px; height: 25px; display: grid; place-items: center; border: 0; border-radius: 4px; color: #778395; background: transparent; cursor: pointer; }
.session-actions button:hover { background: #dce2ea; }
.session-actions button.confirm { color: #a74650; background: #f5dddf; }
.session-actions button:disabled { opacity: .35; cursor: default; }
.session-empty { margin: auto; color: #7f8998; font-size: 12px; }
button:focus-visible, input:focus-visible { outline: 2px solid #6f8fbc; outline-offset: 2px; }
</style>
