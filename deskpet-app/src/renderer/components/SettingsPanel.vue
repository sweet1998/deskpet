<template>
  <Transition name="settings-slide">
    <div v-if="open" class="settings-overlay">
      <div
        class="settings-panel"
        data-pet-ui
        :style="{
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
        }"
        @mousedown.stop
      >
        <div class="settings-header">
          <span>{{ onboarding ? '开始使用麦麦' : '设置' }}</span>
          <button class="settings-close" type="button" title="关闭设置" aria-label="关闭设置" @click="$emit('close')">&times;</button>
        </div>
        <div class="settings-body">
          <div v-if="onboarding" class="onboarding-intro">
            <strong>连接你的 AI 服务</strong>
            <p>使用火山方舟中的 API Key 和模型 Endpoint。验证通过后会安全保存到本机钥匙串。</p>
            <button type="button" @click="openDoubaoConsole">
              <ExternalLink :size="14" /> 打开火山方舟控制台
            </button>
          </div>
          <div class="section provider-section">
            <div class="section-title">AI 服务</div>
            <label>豆包 API Key</label>
            <input
              v-model="doubaoApiKey"
              type="password"
              :placeholder="doubaoHasApiKey ? '已保存，留空则保持不变' : '填写火山方舟 API Key'"
              autocomplete="off"
            />
            <label>模型 / Endpoint ID</label>
            <input v-model="doubaoModel" placeholder="例如 ep-2024xxxxxxxx" />
            <label v-if="onboarding" class="toggle-row legal-consent">
              <input v-model="onboardingConsent" type="checkbox" />
              <span>我已阅读并同意隐私政策与使用条款</span>
            </label>
            <div v-if="onboarding" class="legal-links">
              <button type="button" @click="openProductPage('privacy')">隐私政策 <ExternalLink :size="12" /></button>
              <button type="button" @click="openProductPage('terms')">使用条款 <ExternalLink :size="12" /></button>
            </div>
            <div class="button-row" :class="{ single: onboarding }">
              <button v-if="!onboarding" type="button" :disabled="doubaoBusy" @click="saveDoubao">保存</button>
              <button type="button" :disabled="doubaoBusy || (onboarding && !onboardingConsent)" @click="detectDoubao">
                {{ onboarding ? '验证并完成' : '检测能力' }}
              </button>
            </div>
            <p v-if="doubaoStatus" class="status" :class="doubaoStatusKind">{{ doubaoStatus }}</p>
            <div v-if="aiConfig.capabilitiesChecked" class="capability-list">
              <span :class="{ available: aiConfig.textSupported }">文字</span>
              <span :class="{ available: aiConfig.streamingSupported }">流式</span>
              <span :class="{ available: aiConfig.visionSupported }">视觉</span>
            </div>
            <button
              v-if="onboarding && onboardingReady && !aiConfig.visionSupported"
              class="continue-button"
              type="button"
              @click="finishOnboarding"
            >
              暂不使用屏幕分析，继续
            </button>
            <p class="hint">能力检测会发送两条最短测试请求，产生少量模型用量；截图入口只会在视觉检测通过后启用。</p>
          </div>
          <div v-if="!onboarding" class="section role-section">
            <div class="section-title">角色</div>
            <label>默认角色</label>
            <select v-model="agent.currentRole" :disabled="agent.interruptible || Boolean(agent.confirmation)">
              <option value="default">麦麦</option>
              <option value="stock_expert">炒股专家</option>
            </select>
            <p class="hint">对话栏可随时切换；长期记忆共享，对话历史按角色隔离。</p>
          </div>
          <div v-if="!onboarding" class="section">
            <div class="section-title">显示</div>
            <label class="toggle-row">
              <input
                type="checkbox"
                :checked="desktopOnly"
                @change="setDesktopOnly($event)"
              />
              <span>仅在桌面显示</span>
            </label>
          </div>
          <div v-if="!onboarding" class="section">
            <div class="section-title">记忆与主动陪伴</div>
            <label>你的称呼</label>
            <input v-model="agent.userName" placeholder="例如：小林" />
            <label class="toggle-row">
              <input v-model="agent.proactiveEnabled" type="checkbox" />
              <span>允许低频主动问候</span>
            </label>
            <label class="toggle-row">
              <input v-model="agent.voiceReplyEnabled" type="checkbox" />
              <span>自动朗读回答</span>
            </label>
            <p class="hint">朗读使用 macOS 系统语音，可随时点击停止。</p>
            <div class="time-row">
              <label>安静开始<input v-model="agent.quietStart" type="time" /></label>
              <label>安静结束<input v-model="agent.quietEnd" type="time" /></label>
            </div>
            <label>添加一条长期记忆</label>
            <div class="memory-input">
              <input v-model="newMemory" placeholder="例如：我周五下午需要交周报" @keydown.enter="addMemory" />
              <button type="button" @click="addMemory">添加</button>
            </div>
            <div v-if="agent.memories.length" class="memory-list">
              <div v-for="(memory, index) in agent.memories" :key="memory">
                <span>{{ memory }}</span>
                <button type="button" title="删除记忆" :aria-label="`删除记忆：${memory}`" @click="agent.removeMemory(index)">&times;</button>
              </div>
            </div>
            <p class="hint">记忆保存在本机，可随时删除。</p>
          </div>
          <div v-if="!onboarding" class="section reminder-section">
            <div class="section-title">提醒</div>
            <div class="section-heading-row">
              <p class="hint">提醒由 macOS 在本机调度，退出桌宠后仍会通过系统通知触发。</p>
              <button type="button" :disabled="remindersBusy" @click="loadReminders">刷新</button>
            </div>
            <div v-if="scheduledReminders.length" class="reminder-list">
              <div v-for="reminder in scheduledReminders" :key="reminder.id">
                <span><strong>{{ reminder.body }}</strong><small>{{ formatReminderTime(reminder.dueAt) }}</small></span>
                <button type="button" title="取消提醒" @click="cancelReminder(reminder.id)">&times;</button>
              </div>
            </div>
            <p v-else class="hint">暂无待触发提醒。</p>
          </div>
          <div v-if="!onboarding" class="section privacy-section">
            <div class="section-title">隐私与数据</div>
            <label class="toggle-row">
              <input
                type="checkbox"
                :checked="chat.privacyMode"
                @change="setPrivacyMode($event)"
              />
              <span>隐私模式</span>
            </label>
            <p class="hint">开启后进入独立临时会话，新对话和草稿不会保存；关闭后恢复原历史。</p>
            <p class="storage-security" :class="{ protected: localDataProtected }">
              {{ localDataSecurityText }}
            </p>
            <p class="hint">每个角色最多保留 40 个会话，单个会话最多长期保留 200 条消息。</p>
            <div class="privacy-actions">
              <button type="button" :class="{ confirm: pendingPrivacyAction === 'local' }" @click="clearLocalData">
                {{ pendingPrivacyAction === 'local' ? '再次点击确认清除' : '清除对话、记忆与提醒' }}
              </button>
              <button type="button" :class="{ confirm: pendingPrivacyAction === 'credential' }" @click="clearAiCredential">
                {{ pendingPrivacyAction === 'credential' ? '再次点击确认删除' : '删除 AI 凭据' }}
              </button>
            </div>
            <div class="legal-links product-links">
              <button type="button" @click="openProductPage('privacy')">隐私政策 <ExternalLink :size="12" /></button>
              <button type="button" @click="openProductPage('terms')">使用条款 <ExternalLink :size="12" /></button>
              <button type="button" @click="openProductPage('feedback')">问题反馈 <ExternalLink :size="12" /></button>
            </div>
            <p v-if="privacyStatus" class="status" :class="privacyStatusKind">{{ privacyStatus }}</p>
            <div class="audit-heading">
              <span>最近系统操作</span>
              <button type="button" @click="clearToolAudit">清空</button>
            </div>
            <div v-if="toolAudit.length" class="audit-list">
              <div v-for="entry in toolAudit.slice(0, 8)" :key="entry.id">
                <span><strong>{{ toolLabel(entry.tool) }}</strong><small>{{ entry.summary }}</small></span>
                <em :class="entry.status">{{ auditStatusLabel(entry.status) }}</em>
                <time>{{ formatAuditTime(entry.timestamp) }}</time>
              </div>
            </div>
            <p v-else class="hint">暂无系统操作记录。</p>
          </div>
          <details v-if="!onboarding" class="advanced-settings">
            <summary>高级设置</summary>
            <div class="section">
              <div class="section-title">版本</div>
              <div class="version-row">
                <span>麦麦 AI 桌宠 {{ appVersion }}</span>
                <button type="button" :disabled="updateBusy" @click="checkUpdates">检查更新</button>
              </div>
              <p v-if="updateStatus" class="status" :class="updateStatusKind">{{ updateStatus }}</p>
            </div>
            <div class="section">
              <div class="section-title">AI 接口</div>
              <label>API 地址</label>
              <input :value="doubaoBaseUrl" readonly />
            </div>
            <div class="section">
              <div class="section-title">Live2D 模型</div>
              <label>模型路径</label>
              <input :value="modelPath" @change="setModelPath($event)" placeholder="models/ariu_vts/ariu.model3.json" />
              <p class="hint">修改后需刷新页面生效。</p>
            </div>
            <div class="section">
              <div class="section-title">语音输入</div>
              <p class="hint">默认使用 macOS 系统语音识别。下面的地址只在系统识别不可用时作为可选兜底。</p>
              <button type="button" :disabled="voicePermissionBusy" @click="checkVoicePermissions">检查语音权限</button>
              <p v-if="voicePermissionStatus" class="status" :class="voicePermissionStatusKind">{{ voicePermissionStatus }}</p>
              <label>STT Bridge 地址（可选）</label>
              <input :value="sttUrl" @change="setSttUrl($event)" placeholder="例如 http://127.0.0.1:18530/stt" />
              <label>VAD 灵敏度</label>
              <input type="number" :value="vadThreshold" @change="setVadThreshold($event)" min="0.005" max="0.1" step="0.005" placeholder="0.02" />
              <label>静音判定秒数</label>
              <input type="number" :value="vadSilence" @change="setVadSilence($event)" min="0.5" max="5" step="0.5" placeholder="1.5" />
            </div>
            <div class="section research-service-section">
              <div class="section-title">本地研究服务</div>
              <p class="hint">应用会自动运行内置后端，为炒股专家提供行情和研究数据。</p>
              <div class="button-row">
                <button type="button" :disabled="backendBusy" @click="testBackend">检查服务状态</button>
                <button type="button" :disabled="diagnosticsBusy" @click="exportDiagnostics">导出诊断报告</button>
              </div>
              <p v-if="backendStatus" class="status" :class="backendStatusKind">{{ backendStatus }}</p>
              <p v-if="diagnosticsStatus" class="status" :class="diagnosticsStatusKind">{{ diagnosticsStatus }}</p>
              <p class="hint">诊断报告包含版本、权限、服务状态和脱敏日志，不包含 AI 凭据或对话内容。</p>
            </div>
          </details>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ExternalLink } from 'lucide-vue-next'
import { useAgentStore } from '@/stores/agent'
import { useAiConfigStore } from '@/stores/ai-config'
import { useChatStore } from '@/stores/chat'
import {
  FEEDBACK_URL,
  LEGAL_CONSENT_KEY,
  hasLegalConsent,
} from '../../shared/legal'
import { testBackendConnection } from '@/services/backend-client'
import type {
  NativeReminder,
  NativeToolAuditEntry,
  NativeToolAuditStatus,
  NativeToolName,
} from '../../shared/native-tools'

const props = defineProps<{
  open: boolean
  onboarding: boolean
  left: number
  top: number
  width: number
  height: number
}>()
const emit = defineEmits<{ close: []; configured: [] }>()

function get(k: string, fallback = '') { try { return localStorage.getItem(k) || fallback } catch { return fallback } }
function set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* */ } }

const sttUrl = ref(get('deskpet/stt-url'))
const modelPath = ref(get('deskpet/model-path', ''))
const vadThreshold = ref(get('deskpet/vad-threshold', '0.02'))
const vadSilence = ref(get('deskpet/vad-silence', '1.5'))
const desktopOnly = ref(false)
const doubaoApiKey = ref('')
const doubaoModel = ref('')
const doubaoBaseUrl = ref('https://ark.cn-beijing.volces.com/api/v3')
const doubaoHasApiKey = ref(false)
const doubaoBusy = ref(false)
const doubaoStatus = ref('')
const onboardingConsent = ref(hasLegalConsent())
const doubaoStatusKind = ref<'success' | 'error'>('success')
const backendBusy = ref(false)
const backendStatus = ref('')
const backendStatusKind = ref<'success' | 'error'>('success')
const diagnosticsBusy = ref(false)
const diagnosticsStatus = ref('')
const diagnosticsStatusKind = ref<'success' | 'error'>('success')
const voicePermissionBusy = ref(false)
const voicePermissionStatus = ref('')
const voicePermissionStatusKind = ref<'success' | 'error'>('success')
const agent = useAgentStore()
const aiConfig = useAiConfigStore()
const chat = useChatStore()
const onboardingReady = computed(() => aiConfig.textSupported && aiConfig.streamingSupported)
const newMemory = ref('')
const reminders = ref<NativeReminder[]>([])
const remindersBusy = ref(false)
const pendingPrivacyAction = ref<'local' | 'credential' | ''>('')
const privacyStatus = ref('')
const privacyStatusKind = ref<'success' | 'error'>('success')
const appVersion = ref('')
const updateBusy = ref(false)
const updateStatus = ref('')
const updateStatusKind = ref<'success' | 'error'>('success')
const toolAudit = ref<NativeToolAuditEntry[]>([])
const scheduledReminders = computed(() => reminders.value
  .filter((reminder) => reminder.status === 'scheduled' && reminder.dueAt > Date.now())
  .sort((a, b) => a.dueAt - b.dueAt))
const localDataProtected = computed(() => chat.storageProtected && agent.storageProtected)
const localDataSecurityText = computed(() => {
  if (localDataProtected.value) return '对话、草稿和长期记忆已使用 macOS 钥匙串加密。'
  return chat.storageError || agent.storageError || '正在检查本地数据加密状态。'
})
let unsubscribeDesktopOnly: (() => void) | null = null
let unsubscribeReminder: (() => void) | null = null

onMounted(async () => {
  desktopOnly.value = await window.electronAPI?.getDesktopOnly() ?? false
  appVersion.value = await window.electronAPI?.getAppVersion() ?? ''
  applyDoubaoConfig(await aiConfig.load())
  unsubscribeDesktopOnly = window.electronAPI?.onDesktopOnlyChanged((flag) => {
    desktopOnly.value = flag
  }) ?? null
  unsubscribeReminder = window.electronAPI?.onNativeReminderTriggered(() => {
    void loadReminders()
  }) ?? null
  await loadReminders()
  await loadToolAudit()
})

watch(() => props.open, (open) => {
  if (open) {
    void loadReminders()
    void loadToolAudit()
  }
})

onUnmounted(() => {
  unsubscribeDesktopOnly?.()
  unsubscribeDesktopOnly = null
  unsubscribeReminder?.()
  unsubscribeReminder = null
})

function setSttUrl(e: Event) { const v = (e.target as HTMLInputElement).value; sttUrl.value = v; set('deskpet/stt-url', v) }
function setModelPath(e: Event) { const v = (e.target as HTMLInputElement).value; modelPath.value = v; set('deskpet/model-path', v) }
function setVadThreshold(e: Event) {
  const v = (e.target as HTMLInputElement).value; vadThreshold.value = v; set('deskpet/vad-threshold', v)
}
function setVadSilence(e: Event) {
  const v = (e.target as HTMLInputElement).value; vadSilence.value = v; set('deskpet/vad-silence', v)
}
function setDesktopOnly(e: Event) {
  const enabled = (e.target as HTMLInputElement).checked
  desktopOnly.value = enabled
  void window.electronAPI?.setDesktopOnly(enabled)
}
function setPrivacyMode(e: Event) {
  chat.setPrivacyMode((e.target as HTMLInputElement).checked)
  privacyStatus.value = chat.privacyMode ? '已进入隐私模式。' : '已退出隐私模式并恢复原历史。'
  privacyStatusKind.value = 'success'
}
function openDoubaoConsole() {
  void window.electronAPI?.openNativeUrl('https://console.volcengine.com/ark')
}
async function openProductPage(kind: 'privacy' | 'terms' | 'feedback') {
  const opened = kind === 'feedback'
    ? await window.electronAPI?.openNativeUrl(FEEDBACK_URL)
    : await window.electronAPI?.openProductDocument(kind)
  if (opened) return
  privacyStatus.value = kind === 'feedback' ? '无法打开问题反馈页面。' : '无法打开本地政策文件，请重新安装应用。'
  privacyStatusKind.value = 'error'
}
function finishOnboarding() {
  if (!onboardingConsent.value) return
  localStorage.setItem(LEGAL_CONSENT_KEY, new Date().toISOString())
  emit('configured')
}
function applyDoubaoConfig(config: { model: string; baseUrl: string; hasApiKey: boolean }) {
  doubaoModel.value = config.model
  doubaoBaseUrl.value = config.baseUrl
  doubaoHasApiKey.value = config.hasApiKey
}
async function saveDoubao() {
  doubaoBusy.value = true
  doubaoStatus.value = ''
  try {
    const config = await aiConfig.save({
      apiKey: doubaoApiKey.value,
      model: doubaoModel.value,
    })
    applyDoubaoConfig(config)
    doubaoApiKey.value = ''
    doubaoStatus.value = '豆包配置已保存'
    doubaoStatusKind.value = 'success'
  } catch (error) {
    doubaoStatus.value = error instanceof Error ? error.message : '保存失败'
    doubaoStatusKind.value = 'error'
  } finally {
    doubaoBusy.value = false
  }
}
async function detectDoubao() {
  if (!doubaoHasApiKey.value && !doubaoApiKey.value.trim()) {
    doubaoStatus.value = '请先填写火山方舟 API Key'
    doubaoStatusKind.value = 'error'
    return
  }
  if (!doubaoModel.value.trim()) {
    doubaoStatus.value = '请填写模型 Endpoint ID'
    doubaoStatusKind.value = 'error'
    return
  }
  doubaoBusy.value = true
  doubaoStatus.value = '正在检测文字、流式和视觉能力…'
  doubaoStatusKind.value = 'success'
  try {
    const report = await aiConfig.detect({
      apiKey: doubaoApiKey.value,
      model: doubaoModel.value,
    })
    if (!report.text) throw new Error(report.errors.text || '文字连接失败')
    if (!report.streaming) throw new Error(report.errors.streaming || '当前模型不支持流式回答')
    applyDoubaoConfig(aiConfig.config)
    doubaoApiKey.value = ''
    doubaoStatus.value = report.vision
      ? '检测完成：文字、流式回答和屏幕理解均可用。'
      : '文字与流式回答可用；当前模型不支持屏幕理解。'
    doubaoStatusKind.value = 'success'
    if (props.onboarding && report.vision) finishOnboarding()
  } catch (error) {
    doubaoStatus.value = error instanceof Error ? error.message : '能力检测失败'
    doubaoStatusKind.value = 'error'
  } finally {
    doubaoBusy.value = false
  }
}
function addMemory() {
  agent.addMemory(newMemory.value)
  newMemory.value = ''
}

async function loadReminders() {
  remindersBusy.value = true
  try {
    reminders.value = await window.electronAPI?.listNativeReminders() ?? []
  } finally {
    remindersBusy.value = false
  }
}

async function cancelReminder(id: string) {
  await window.electronAPI?.cancelNativeReminder(id)
  await loadReminders()
}

async function clearLocalData() {
  if (pendingPrivacyAction.value !== 'local') {
    pendingPrivacyAction.value = 'local'
    privacyStatus.value = '此操作不可撤销。请再次点击确认。'
    privacyStatusKind.value = 'error'
    return
  }
  const conversationsCleared = await chat.clearAllConversations()
  if (!conversationsCleared) {
    pendingPrivacyAction.value = ''
    privacyStatus.value = chat.storageError || '无法清除加密对话。'
    privacyStatusKind.value = 'error'
    return
  }
  agent.clearPersonalData()
  await window.electronAPI?.clearNativeReminders()
  await window.electronAPI?.clearNativeToolAudit()
  reminders.value = []
  toolAudit.value = []
  pendingPrivacyAction.value = ''
  privacyStatus.value = '对话、草稿、长期记忆和提醒已清除。'
  privacyStatusKind.value = 'success'
}

async function loadToolAudit() {
  toolAudit.value = await window.electronAPI?.listNativeToolAudit() ?? []
}

async function clearToolAudit() {
  await window.electronAPI?.clearNativeToolAudit()
  toolAudit.value = []
}

const TOOL_LABELS: Record<NativeToolName, string> = {
  extract_file: '读取文件',
  capture_screen: '屏幕截图',
  list_reminders: '查看提醒',
  create_reminder: '创建提醒',
  cancel_reminder: '取消提醒',
  write_clipboard: '写入剪贴板',
  open_url: '打开网页',
  reveal_path: 'Finder 定位',
}

function toolLabel(tool: NativeToolName): string {
  return TOOL_LABELS[tool]
}

function auditStatusLabel(status: NativeToolAuditStatus): string {
  return {
    requested: '已请求',
    awaiting_confirmation: '待确认',
    denied: '已拒绝',
    succeeded: '已完成',
    failed: '失败',
  }[status]
}

function formatAuditTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

async function clearAiCredential() {
  if (pendingPrivacyAction.value !== 'credential') {
    pendingPrivacyAction.value = 'credential'
    privacyStatus.value = '删除后需要重新配置豆包。请再次点击确认。'
    privacyStatusKind.value = 'error'
    return
  }
  try {
    await aiConfig.clear()
    doubaoApiKey.value = ''
    applyDoubaoConfig(aiConfig.config)
    pendingPrivacyAction.value = ''
    privacyStatus.value = 'AI 凭据和能力检测结果已删除。'
    privacyStatusKind.value = 'success'
  } catch (error) {
    privacyStatus.value = error instanceof Error ? error.message : '删除 AI 凭据失败'
    privacyStatusKind.value = 'error'
  }
}

async function checkUpdates() {
  updateBusy.value = true
  updateStatus.value = '正在检查更新…'
  updateStatusKind.value = 'success'
  try {
    const started = await window.electronAPI?.checkForUpdates()
    updateStatus.value = started
      ? '已开始检查，结果会通过系统对话框提示。'
      : '开发模式不检查更新；正式安装包中可用。'
  } catch (error) {
    updateStatus.value = error instanceof Error ? error.message : '检查更新失败'
    updateStatusKind.value = 'error'
  } finally {
    updateBusy.value = false
  }
}

function formatReminderTime(dueAt: number): string {
  return new Date(dueAt).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

async function testBackend() {
  backendBusy.value = true
  backendStatus.value = '正在连接桌宠后端…'
  try {
    const result = await testBackendConnection()
    backendStatus.value = result.message
    backendStatusKind.value = result.ok ? 'success' : 'error'
  } finally {
    backendBusy.value = false
  }
}

async function exportDiagnostics() {
  diagnosticsBusy.value = true
  diagnosticsStatus.value = ''
  try {
    const exported = await window.electronAPI?.exportDiagnostics()
    diagnosticsStatus.value = exported ? '诊断报告已导出。' : '已取消导出。'
    diagnosticsStatusKind.value = 'success'
  } catch (error) {
    diagnosticsStatus.value = error instanceof Error ? error.message : '导出诊断报告失败'
    diagnosticsStatusKind.value = 'error'
  } finally {
    diagnosticsBusy.value = false
  }
}

function permissionLabel(value: string): string {
  return {
    granted: '已允许',
    authorized: '已允许',
    denied: '已拒绝',
    restricted: '受系统限制',
    'not-determined': '尚未请求',
    unknown: '状态未知',
    unavailable: '不可用',
  }[value] || value
}

async function checkVoicePermissions() {
  voicePermissionBusy.value = true
  voicePermissionStatus.value = '正在检查权限…'
  try {
    const result = await window.electronAPI?.getVoicePermissionStatus()
    if (!result?.platformSupported || !result.helperAvailable) {
      voicePermissionStatus.value = '当前系统或安装包缺少内置语音识别组件。'
      voicePermissionStatusKind.value = 'error'
      return
    }
    voicePermissionStatus.value = `麦克风：${permissionLabel(result.microphone)}；语音识别：${permissionLabel(result.speechRecognition)}`
    voicePermissionStatusKind.value = result.microphone === 'granted' && result.speechRecognition === 'authorized'
      ? 'success'
      : 'error'
  } catch (error) {
    voicePermissionStatus.value = error instanceof Error ? error.message : '无法检查语音权限'
    voicePermissionStatusKind.value = 'error'
  } finally {
    voicePermissionBusy.value = false
  }
}
</script>

<style scoped>
.settings-overlay {
  position: absolute;
  inset: 0;
  z-index: 70;
}
.settings-panel {
  position: absolute;
  background: rgba(29, 38, 52, 0.97);
  backdrop-filter: blur(16px);
  display: flex;
  flex-direction: column;
}
.settings-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px; color: #ddd; font-size: 15px; font-weight: 600;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.settings-close { background: none; border: none; color: #999; font-size: 20px; cursor: pointer; }
.settings-body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 18px; }
.onboarding-intro { padding: 10px 11px; border: 1px solid rgba(111,143,188,.28); border-radius: 6px; color: #d9e2ee; background: rgba(85,119,167,.12); }
.onboarding-intro strong { font-size: 13px; }
.onboarding-intro p { margin: 4px 0 0; color: #a8b3c2; font-size: 12px; line-height: 1.5; }
.onboarding-intro button { margin-top: 8px; padding: 5px 0; display: inline-flex; align-items: center; gap: 5px; border: 0; color: #a9c3e5; background: transparent; cursor: pointer; font-size: 12px; }
.section { display: flex; flex-direction: column; gap: 6px; }
.section-title { color: #aab3c0; font-size: 12px; text-transform: uppercase; letter-spacing: 0; }
label { color: #c4cad3; font-size: 13px; }
.toggle-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.toggle-row input { width: 16px; height: 16px; margin: 0; accent-color: #6f8fbc; }
.time-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.time-row label { display: flex; flex-direction: column; gap: 5px; }
.memory-input { display: flex; gap: 6px; }
.memory-input input { min-width: 0; flex: 1; }
.memory-input button { flex: none; border: 1px solid rgba(111,143,188,.5); border-radius: 6px; color: #e0e8f4; background: rgba(111,143,188,.18); cursor: pointer; }
.memory-list { display: flex; flex-direction: column; border-top: 1px solid rgba(255,255,255,.08); }
.memory-list div { display: flex; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
.memory-list span { flex: 1; min-width: 0; color: #bac2cd; font-size: 12px; line-height: 1.45; }
.memory-list button { border: 0; color: #888; background: transparent; cursor: pointer; }
.section-heading-row { display: flex; align-items: center; gap: 8px; }
.section-heading-row .hint { min-width: 0; flex: 1; }
.section-heading-row button { flex: none; padding: 5px 8px; border: 1px solid rgba(111,143,188,.35); border-radius: 5px; color: #c1ccdc; background: transparent; cursor: pointer; font-size: 12px; }
.reminder-list { display: flex; flex-direction: column; border-top: 1px solid rgba(255,255,255,.08); }
.reminder-list > div { min-height: 42px; display: flex; align-items: center; gap: 7px; border-bottom: 1px solid rgba(255,255,255,.06); }
.reminder-list span { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.reminder-list strong { overflow: hidden; color: #c7d0dc; font-size: 12px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.reminder-list small { color: #8d99aa; font-size: 11px; }
.reminder-list button { width: 24px; height: 24px; border: 0; color: #8c7780; background: transparent; cursor: pointer; }
.privacy-actions { display: grid; gap: 5px; }
.storage-security { margin: 0; color: #df929b; font-size: 12px; line-height: 1.45; }
.storage-security.protected { color: #8fc4a7; }
.privacy-actions button { min-height: 34px; border: 1px solid rgba(126,139,158,.3); border-radius: 6px; color: #bdc6d3; background: rgba(255,255,255,.03); cursor: pointer; font-size: 12px; }
.privacy-actions button:hover { background: rgba(255,255,255,.06); }
.privacy-actions button.confirm { border-color: rgba(196,91,103,.42); color: #df8790; background: rgba(127,63,73,.15); }
.audit-heading { margin-top: 4px; display: flex; align-items: center; justify-content: space-between; color: #a4afbd; font-size: 12px; }
.audit-heading button { border: 0; color: #98a4b5; background: transparent; cursor: pointer; font-size: 11px; }
.audit-list { display: flex; flex-direction: column; border-top: 1px solid rgba(255,255,255,.06); }
.audit-list > div { min-height: 42px; padding: 5px 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 2px 7px; border-bottom: 1px solid rgba(255,255,255,.05); }
.audit-list span { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.audit-list strong { color: #c0c9d5; font-size: 12px; font-weight: 500; }
.audit-list small { overflow: hidden; color: #929eae; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.audit-list em { padding: 2px 5px; border-radius: 4px; color: #9aa8ba; background: rgba(255,255,255,.05); font-size: 10px; font-style: normal; }
.audit-list em.succeeded { color: #8fc4a7; background: rgba(52,112,82,.15); }
.audit-list em.failed, .audit-list em.denied { color: #d58b94; background: rgba(127,63,73,.15); }
.audit-list time { grid-column: 1 / -1; color: #8490a1; font-size: 10px; }
input, select {
  width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06); color: #eee; font-size: 12px; outline: none;
}
input:focus, select:focus { border-color: rgba(111, 143, 188, 0.72); }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid #86a6d2; outline-offset: 2px; }
input[readonly] { color: #8996a9; }
.button-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
.button-row.single { grid-template-columns: 1fr; }
.button-row button { height: 34px; border: 1px solid rgba(111,143,188,.55); border-radius: 6px; color: #e7edf6; background: rgba(85,119,167,.28); cursor: pointer; }
.button-row button:last-child { color: #fff; background: #5577a7; }
.button-row button:disabled { opacity: .5; cursor: default; }
.legal-consent { margin-top: 4px; align-items: flex-start; line-height: 1.4; }
.legal-links { display: flex; align-items: center; gap: 10px; }
.legal-links button { padding: 2px 0; display: inline-flex; align-items: center; gap: 3px; border: 0; color: #9eb8dc; background: transparent; cursor: pointer; font-size: 11px; }
.product-links { margin-top: 2px; flex-wrap: wrap; }
.capability-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
.capability-list span { height: 28px; display: grid; place-items: center; border: 1px solid rgba(223,135,144,.22); border-radius: 5px; color: #c28993; background: rgba(127,63,73,.13); font-size: 12px; }
.capability-list span.available { border-color: rgba(98,155,126,.3); color: #8fc4a7; background: rgba(52,112,82,.15); }
.continue-button { height: 34px; border: 1px solid rgba(111,143,188,.5); border-radius: 6px; color: #dce6f2; background: rgba(85,119,167,.22); cursor: pointer; font-size: 12px; }
.advanced-settings { border-top: 1px solid rgba(255,255,255,.08); }
.advanced-settings summary { padding: 10px 0; color: #a0aaba; cursor: pointer; font-size: 12px; }
.advanced-settings[open] { display: flex; flex-direction: column; gap: 16px; }
.advanced-settings[open] summary { margin-bottom: -4px; }
.version-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: #bbc4d1; font-size: 12px; }
.version-row button { flex: none; padding: 5px 8px; border: 1px solid rgba(111,143,188,.35); border-radius: 5px; color: #c8d3e2; background: transparent; cursor: pointer; font-size: 11px; }
.version-row button:disabled { opacity: .45; cursor: default; }
.status { margin: 2px 0 0; font-size: 12px; line-height: 1.45; }
.status.success { color: #d7b36a; }
.status.error { color: #df8790; }
.hint { color: #929cab; font-size: 12px; line-height: 1.45; margin: 0; }

.settings-slide-enter-active, .settings-slide-leave-active { transition: all 0.25s ease; }
.settings-slide-enter-from, .settings-slide-leave-to { opacity: 0; }
.settings-slide-enter-from .settings-panel, .settings-slide-leave-to .settings-panel { transform: translateX(40px); }
.settings-slide-enter-active .settings-panel, .settings-slide-leave-active .settings-panel { transition: transform 0.25s ease; }
</style>
