import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
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
  quietStart: string
  quietEnd: string
  currentRole: RoleId
}

const DEFAULT_PREFERENCES: AgentPreferences = {
  userName: '',
  proactiveEnabled: true,
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

export const useAgentStore = defineStore('agent', () => {
  const persisted = readJson(PREFERENCES_KEY, DEFAULT_PREFERENCES)
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
  const interactionOpen = ref(false)
  const conversationOpen = ref(false)
  const taskPanelOpen = ref(false)
  const recording = ref(false)
  const proactiveMessage = ref('')
  const userName = ref(persisted.userName)
  const proactiveEnabled = ref(persisted.proactiveEnabled)
  const quietStart = ref(persisted.quietStart)
  const quietEnd = ref(persisted.quietEnd)
  const currentRole = ref<RoleId>(normalizeRoleId(persisted.currentRole))
  const memories = ref<string[]>(readJson<string[]>(MEMORIES_KEY, []))

  const workspaceOpen = computed(() => Boolean(
    interactionOpen.value
    || conversationOpen.value
    || taskPanelOpen.value
    || confirmation.value
    || proactiveMessage.value,
  ))

  watch([userName, proactiveEnabled, quietStart, quietEnd, currentRole], () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
      userName: userName.value,
      proactiveEnabled: proactiveEnabled.value,
      quietStart: quietStart.value,
      quietEnd: quietEnd.value,
      currentRole: currentRole.value,
    }))
  })
  watch(memories, (value) => {
    localStorage.setItem(MEMORIES_KEY, JSON.stringify(value))
  }, { deep: true })

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
    const normalized = value.trim()
    if (!normalized || memories.value.includes(normalized)) return
    memories.value.push(normalized)
  }

  function removeMemory(index: number) {
    memories.value.splice(index, 1)
  }

  function closeWorkspace() {
    interactionOpen.value = false
    conversationOpen.value = false
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
    interactionOpen,
    conversationOpen,
    taskPanelOpen,
    recording,
    proactiveMessage,
    userName,
    proactiveEnabled,
    quietStart,
    quietEnd,
    currentRole,
    memories,
    workspaceOpen,
    beginRequest,
    touchRequest,
    applyState,
    setResult,
    setConfirmation,
    addMemory,
    removeMemory,
    closeWorkspace,
  }
})
