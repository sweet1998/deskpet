import { computed, ref, watch } from 'vue'
import { acceptHMRUpdate, defineStore } from 'pinia'
import type {
  AgentConfirmation,
  AgentState,
  AgentStateEvent,
  AgentTaskResult,
} from '@/services/agent-protocol'
import { normalizeRoleId, type RoleId } from '../../shared/roles'

const PREFERENCES_KEY = 'deskpet/agent-preferences'
const MEMORIES_KEY = 'deskpet/agent-memories'

interface AgentPreferences {
  userName: string
  proactiveEnabled: boolean
  voiceReplyEnabled: boolean
  quietStart: string
  quietEnd: string
  currentRole: RoleId
}

interface SecureAgentState {
  version: 1
  preferences: AgentPreferences
  memories: string[]
}

const DEFAULT_PREFERENCES: AgentPreferences = {
  userName: '',
  proactiveEnabled: true,
  voiceReplyEnabled: false,
  quietStart: '22:00',
  quietEnd: '08:00',
  currentRole: 'default',
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

function normalizePreferences(value: unknown): AgentPreferences {
  const input = value && typeof value === 'object' ? value as Partial<AgentPreferences> : {}
  return {
    userName: typeof input.userName === 'string' ? input.userName.trim().slice(0, 80) : '',
    proactiveEnabled: typeof input.proactiveEnabled === 'boolean' ? input.proactiveEnabled : true,
    voiceReplyEnabled: typeof input.voiceReplyEnabled === 'boolean' ? input.voiceReplyEnabled : false,
    quietStart: typeof input.quietStart === 'string' && /^\d{2}:\d{2}$/.test(input.quietStart)
      ? input.quietStart
      : DEFAULT_PREFERENCES.quietStart,
    quietEnd: typeof input.quietEnd === 'string' && /^\d{2}:\d{2}$/.test(input.quietEnd)
      ? input.quietEnd
      : DEFAULT_PREFERENCES.quietEnd,
    currentRole: normalizeRoleId(input.currentRole),
  }
}

function normalizeMemories(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.flatMap((item) => (
        typeof item === 'string' && item.trim() ? [item.trim().slice(0, 500)] : []
      )))].slice(0, 30)
    : []
}

export const useAgentStore = defineStore('agent', () => {
  const persisted = normalizePreferences(readJson(PREFERENCES_KEY, DEFAULT_PREFERENCES))
  const state = ref<AgentState>('idle')
  const activeRequestId = ref('')
  const progress = ref(0)
  const currentStep = ref('')
  const error = ref('')
  const interruptible = ref(false)
  const activityVersion = ref(0)
  const sourceName = ref('')
  const taskGoal = ref('')
  const taskResult = ref<AgentTaskResult | null>(null)
  const confirmation = ref<AgentConfirmation | null>(null)
  const chatOpen = ref(false)
  const taskPanelOpen = ref(false)
  const recording = ref(false)
  const proactiveMessage = ref('')
  const userName = ref(persisted.userName)
  const proactiveEnabled = ref(persisted.proactiveEnabled)
  const voiceReplyEnabled = ref(persisted.voiceReplyEnabled)
  const quietStart = ref(persisted.quietStart)
  const quietEnd = ref(persisted.quietEnd)
  const currentRole = ref<RoleId>(normalizeRoleId(persisted.currentRole))
  const memories = ref<string[]>(normalizeMemories(readJson<string[]>(MEMORIES_KEY, [])))
  const storageProtected = ref(false)
  const storageError = ref('')
  let storageHydrated = false
  let secureSaveTimer: ReturnType<typeof setTimeout> | null = null

  const workspaceOpen = computed(() => Boolean(
    chatOpen.value
    || taskPanelOpen.value
    || confirmation.value
    || proactiveMessage.value,
  ))

  function secureState(): SecureAgentState {
    return {
      version: 1,
      preferences: {
        userName: userName.value,
        proactiveEnabled: proactiveEnabled.value,
        voiceReplyEnabled: voiceReplyEnabled.value,
        quietStart: quietStart.value,
        quietEnd: quietEnd.value,
        currentRole: currentRole.value,
      },
      memories: normalizeMemories(memories.value),
    }
  }

  function schedulePersistence(): void {
    if (!storageProtected.value) {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(secureState().preferences))
      localStorage.setItem(MEMORIES_KEY, JSON.stringify(secureState().memories))
      return
    }
    if (secureSaveTimer) clearTimeout(secureSaveTimer)
    secureSaveTimer = setTimeout(() => {
      secureSaveTimer = null
      void window.electronAPI?.writeSecureUserData('agent', secureState()).then((saved) => {
        if (!saved) storageError.value = '无法安全保存记忆，请检查 macOS 钥匙串状态。'
      })
    }, 150)
  }

  watch([userName, proactiveEnabled, voiceReplyEnabled, quietStart, quietEnd, currentRole], () => {
    schedulePersistence()
  })
  watch(memories, schedulePersistence, { deep: true })

  async function hydrateSecureStorage(): Promise<boolean> {
    if (storageHydrated) return storageProtected.value
    storageHydrated = true
    const result = await window.electronAPI?.readSecureUserData('agent')
    if (!result?.available) {
      storageError.value = result?.error || 'macOS 钥匙串当前不可用，记忆仍保存在本机旧存储中。'
      return false
    }
    if (result.exists && result.error) {
      storageError.value = '无法读取已加密的记忆数据，未覆盖原文件。'
      return false
    }
    if (result.exists && result.value && typeof result.value === 'object') {
      const stored = result.value as Partial<SecureAgentState>
      if (stored.version === 1) {
        const restored = normalizePreferences(stored.preferences)
        userName.value = restored.userName
        proactiveEnabled.value = restored.proactiveEnabled
        voiceReplyEnabled.value = restored.voiceReplyEnabled
        quietStart.value = restored.quietStart
        quietEnd.value = restored.quietEnd
        currentRole.value = restored.currentRole
        memories.value = normalizeMemories(stored.memories)
      }
    }
    const saved = await window.electronAPI?.writeSecureUserData('agent', secureState())
    if (!saved) {
      storageError.value = '无法完成记忆数据安全迁移。'
      return false
    }
    storageProtected.value = true
    storageError.value = ''
    localStorage.removeItem(PREFERENCES_KEY)
    localStorage.removeItem(MEMORIES_KEY)
    return true
  }

  function beginRequest(requestId: string, goal = '', fileName = '') {
    activeRequestId.value = requestId
    taskGoal.value = goal
    sourceName.value = fileName
    taskResult.value = null
    error.value = ''
    progress.value = 0
    currentStep.value = ''
    touchRequest(requestId)
  }

  function touchRequest(requestId: string) {
    if (!requestId || requestId !== activeRequestId.value) return
    activityVersion.value += 1
  }

  function applyState(event: AgentStateEvent) {
    if (event.requestId) activeRequestId.value = event.requestId
    state.value = event.state
    progress.value = Math.max(0, Math.min(100, event.progress ?? progress.value))
    currentStep.value = event.step ?? currentStep.value
    interruptible.value = event.interruptible ?? false
    error.value = event.error ?? ''
    touchRequest(event.requestId || activeRequestId.value)
  }

  function setResult(result: AgentTaskResult) {
    taskResult.value = result
    activeRequestId.value = result.requestId
    progress.value = 100
    currentStep.value = '任务完成'
    state.value = 'success'
    interruptible.value = false
    touchRequest(result.requestId)
    taskPanelOpen.value = true
  }

  function setConfirmation(value: AgentConfirmation | null) {
    confirmation.value = value
    if (value) {
      activeRequestId.value = value.requestId
      state.value = 'awaiting_confirmation'
      taskPanelOpen.value = true
    }
  }

  function addMemory(value: string) {
    const normalized = value.trim().slice(0, 500)
    if (!normalized || memories.value.includes(normalized) || memories.value.length >= 30) return false
    memories.value.push(normalized)
    return true
  }

  function removeMemory(index: number) {
    memories.value.splice(index, 1)
  }

  function clearMemories() {
    memories.value = []
  }

  function clearPersonalData() {
    userName.value = ''
    memories.value = []
    localStorage.removeItem(MEMORIES_KEY)
    schedulePersistence()
  }

  function closeWorkspace() {
    chatOpen.value = false
    taskPanelOpen.value = false
    proactiveMessage.value = ''
  }

  return {
    state,
    activeRequestId,
    progress,
    currentStep,
    error,
    interruptible,
    activityVersion,
    sourceName,
    taskGoal,
    taskResult,
    confirmation,
    chatOpen,
    taskPanelOpen,
    recording,
    proactiveMessage,
    userName,
    proactiveEnabled,
    voiceReplyEnabled,
    quietStart,
    quietEnd,
    currentRole,
    memories,
    storageProtected,
    storageError,
    workspaceOpen,
    beginRequest,
    touchRequest,
    applyState,
    setResult,
    setConfirmation,
    addMemory,
    removeMemory,
    clearMemories,
    clearPersonalData,
    closeWorkspace,
    hydrateSecureStorage,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAgentStore, import.meta.hot))
}
