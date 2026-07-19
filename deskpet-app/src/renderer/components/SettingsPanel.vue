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
          <span>设置</span>
          <button class="settings-close" @click="$emit('close')">&times;</button>
        </div>
        <div class="settings-body">
          <div class="section provider-section">
            <div class="section-title">AI 服务</div>
            <label>服务商</label>
            <select v-model="aiProvider" @change="changeAiProvider">
              <option value="doubao">豆包（火山方舟）</option>
              <option value="maibot">MaiBot</option>
              <option value="backend">桌宠后端（推荐）</option>
            </select>
            <template v-if="aiProvider === 'doubao'">
              <label>API Key</label>
              <input
                v-model="doubaoApiKey"
                type="password"
                :placeholder="doubaoHasApiKey ? '已保存，留空则保持不变' : '填写火山方舟 API Key'"
                autocomplete="off"
              />
              <label>模型 / Endpoint ID</label>
              <input v-model="doubaoModel" placeholder="例如 ep-2024xxxxxxxx" />
              <label>API 地址</label>
              <input :value="doubaoBaseUrl" readonly />
              <div class="button-row">
                <button type="button" :disabled="doubaoBusy" @click="saveDoubao">保存</button>
                <button type="button" :disabled="doubaoBusy" @click="testDoubao">测试连接</button>
              </div>
              <p v-if="doubaoStatus" class="status" :class="doubaoStatusKind">{{ doubaoStatus }}</p>
              <p class="hint">API Key 仅保存在本机应用数据目录，不会写入网页存储。</p>
            </template>
            <template v-if="aiProvider === 'backend'">
              <p class="hint">后端连接在下方“行情数据”中配置，角色、行情和模型密钥均由后端统一管理。</p>
            </template>
          </div>
          <div class="section role-section">
            <div class="section-title">角色</div>
            <label>默认角色</label>
            <select v-model="agent.currentRole">
              <option value="default">麦麦</option>
              <option value="stock_expert">炒股专家</option>
            </select>
            <p class="hint">对话栏可随时切换；长期记忆共享，对话历史按角色隔离。</p>
          </div>
          <div class="section market-section">
            <div class="section-title">行情数据</div>
            <label>行情来源</label>
            <select v-model="marketSource" @change="changeMarketSource">
              <option value="backend">桌宠后端（免安装，推荐）</option>
              <option value="opend">本地富途 OpenD（高级）</option>
            </select>
            <template v-if="marketSource === 'backend'">
              <label>后端地址</label>
              <input v-model="backendUrl" placeholder="http://127.0.0.1:18540" />
              <label>访问令牌</label>
              <input v-model="backendToken" type="password" placeholder="与 DESKPET_API_TOKEN 一致" autocomplete="off" />
              <div class="button-row">
                <button type="button" :disabled="backendBusy" @click="saveBackend">保存</button>
                <button type="button" :disabled="backendBusy" @click="testBackend">测试连接</button>
              </div>
              <p v-if="backendStatus" class="status" :class="backendStatusKind">{{ backendStatus }}</p>
              <p class="hint">默认通过后端获取腾讯行情，用户无需安装 OpenD。</p>
            </template>
            <template v-else>
              <label>OpenD Host</label>
              <input v-model="marketOpenDHost" placeholder="127.0.0.1" />
              <label>OpenD Port</label>
              <input v-model.number="marketOpenDPort" type="number" min="1" max="65535" placeholder="11111" />
              <label>行情桥地址</label>
              <input v-model="marketBridgeUrl" placeholder="http://127.0.0.1:18531" />
              <div class="button-row">
                <button type="button" :disabled="marketBusy" @click="saveMarket">保存</button>
                <button type="button" :disabled="marketBusy" @click="testMarket">测试连接</button>
              </div>
              <p v-if="marketStatus" class="status" :class="marketStatusKind">{{ marketStatus }}</p>
              <p class="hint">高级数据源，仅适用于已安装并登录 OpenD 的用户。</p>
            </template>
          </div>
          <!-- MaiBot 连接 -->
          <div v-if="aiProvider === 'maibot'" class="section">
            <div class="section-title">MaiBot 连接</div>
            <label>WS 地址</label>
            <input :value="wsUrl" @change="setWsUrl($event)" placeholder="ws://127.0.0.1:8523/ws" />
            <label>WS Token</label>
            <input :value="wsToken" @change="setWsToken($event)" placeholder="留空不验证" />
            <p class="hint">修改后需刷新页面生效</p>
          </div>
          <!-- 显示 -->
          <div class="section">
            <div class="section-title">显示</div>
            <label class="toggle-row">
              <input
                type="checkbox"
                :checked="desktopOnly"
                @change="setDesktopOnly($event)"
              />
              <span>仅在桌面显示</span>
            </label>
            <label>模型路径</label>
            <input :value="modelPath" @change="setModelPath($event)" placeholder="models/ariu_vts/ariu.model3.json" />
            <p class="hint">修改后需刷新页面生效</p>
          </div>
          <!-- 麦克风 -->
          <div class="section">
            <div class="section-title">麦克风</div>
            <label>STT 地址</label>
            <input :value="sttUrl" @change="setSttUrl($event)" placeholder="http://127.0.0.1:18530/stt" />
            <label>VAD 灵敏度 (0.01~0.1，越小越灵敏)</label>
            <input type="number" :value="vadThreshold" @change="setVadThreshold($event)" min="0.005" max="0.1" step="0.005" placeholder="0.02" />
            <label>静音判定秒数</label>
            <input type="number" :value="vadSilence" @change="setVadSilence($event)" min="0.5" max="5" step="0.5" placeholder="1.5" />
          </div>
          <!-- 截图 -->
          <div class="section">
            <div class="section-title">截图</div>
            <p class="hint">托盘菜单 → 截图识图（手动）</p>
            <p class="hint">托盘菜单 → 自动截图（定期截屏发给 MaiBot）</p>
            <label>自动截图间隔（秒）</label>
            <input type="number" :value="autoSsInterval" @change="setAutoSsInterval($event)" min="10" step="5" placeholder="60" />
            <p class="hint">修改后即时生效，需先开启托盘"自动截图"</p>
          </div>
          <div class="section">
            <div class="section-title">记忆与主动陪伴</div>
            <label>你的称呼</label>
            <input v-model="agent.userName" placeholder="例如：小林" />
            <label class="toggle-row">
              <input v-model="agent.proactiveEnabled" type="checkbox" />
              <span>允许低频主动问候</span>
            </label>
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
                <button type="button" title="删除记忆" @click="agent.removeMemory(index)">&times;</button>
              </div>
            </div>
            <p class="hint">记忆保存在本机，可随时删除。</p>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useAgentStore } from '@/stores/agent'
import { getAiProvider, setAiProvider } from '@/services/ai-provider'
import type { AiProvider } from '../../shared/doubao'
import type { MarketBridgeConfig } from '../../shared/market'
import {
  getBackendToken,
  getBackendUrl,
  getMarketSource,
  setBackendToken,
  setBackendUrl,
  setMarketSource,
  testBackendConnection,
  type MarketSource,
} from '@/services/backend-client'

defineProps<{
  open: boolean
  left: number
  top: number
  width: number
  height: number
}>()
defineEmits<{ close: [] }>()

function get(k: string, fallback = '') { try { return localStorage.getItem(k) || fallback } catch { return fallback } }
function set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* */ } }

const wsUrl = ref(get('deskpet/ws-url', 'ws://127.0.0.1:8523/ws'))
const wsToken = ref(get('deskpet/ws-token'))
const sttUrl = ref(get('deskpet/stt-url', 'http://127.0.0.1:18530/stt'))
const modelPath = ref(get('deskpet/model-path', ''))
const autoSsInterval = ref(get('deskpet/auto-screenshot-interval', '60'))
const vadThreshold = ref(get('deskpet/vad-threshold', '0.02'))
const vadSilence = ref(get('deskpet/vad-silence', '1.5'))
const desktopOnly = ref(false)
const aiProvider = ref<AiProvider>(getAiProvider())
const doubaoApiKey = ref('')
const doubaoModel = ref('')
const doubaoBaseUrl = ref('https://ark.cn-beijing.volces.com/api/v3')
const doubaoHasApiKey = ref(false)
const doubaoBusy = ref(false)
const doubaoStatus = ref('')
const doubaoStatusKind = ref<'success' | 'error'>('success')
const marketOpenDHost = ref('127.0.0.1')
const marketOpenDPort = ref(11111)
const marketBridgeUrl = ref('http://127.0.0.1:18531')
const marketBusy = ref(false)
const marketStatus = ref('')
const marketStatusKind = ref<'success' | 'error'>('success')
const backendUrl = ref(getBackendUrl())
const backendToken = ref(getBackendToken())
const backendBusy = ref(false)
const backendStatus = ref('')
const backendStatusKind = ref<'success' | 'error'>('success')
const marketSource = ref<MarketSource>(getMarketSource())
const agent = useAgentStore()
const newMemory = ref('')
let unsubscribeDesktopOnly: (() => void) | null = null

onMounted(async () => {
  desktopOnly.value = await window.electronAPI?.getDesktopOnly() ?? false
  const config = await window.electronAPI?.getDoubaoConfig()
  if (config) {
    doubaoModel.value = config.model
    doubaoBaseUrl.value = config.baseUrl
    doubaoHasApiKey.value = config.hasApiKey
  }
  const marketConfig = await window.electronAPI?.getMarketConfig()
  if (marketConfig) applyMarketConfig(marketConfig)
  unsubscribeDesktopOnly = window.electronAPI?.onDesktopOnlyChanged((flag) => {
    desktopOnly.value = flag
  }) ?? null
})

onUnmounted(() => {
  unsubscribeDesktopOnly?.()
  unsubscribeDesktopOnly = null
})

function setWsUrl(e: Event) { const v = (e.target as HTMLInputElement).value; wsUrl.value = v; set('deskpet/ws-url', v) }
function setWsToken(e: Event) { const v = (e.target as HTMLInputElement).value; wsToken.value = v; set('deskpet/ws-token', v) }
function setSttUrl(e: Event) { const v = (e.target as HTMLInputElement).value; sttUrl.value = v; set('deskpet/stt-url', v) }
function setModelPath(e: Event) { const v = (e.target as HTMLInputElement).value; modelPath.value = v; set('deskpet/model-path', v) }
function setAutoSsInterval(e: Event) {
  const v = (e.target as HTMLInputElement).value; autoSsInterval.value = v; set('deskpet/auto-screenshot-interval', v)
  window.electronAPI?.setAutoScreenshotInterval(parseInt(v) || 60)
}
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
function changeAiProvider() {
  setAiProvider(aiProvider.value)
  doubaoStatus.value = aiProvider.value === 'doubao'
    ? '已切换为豆包，保存配置后即可对话。'
    : aiProvider.value === 'maibot'
      ? '已切换为 MaiBot，刷新应用后建立 WebSocket 连接。'
      : '已切换为桌宠后端，保存地址后即可使用。'
  doubaoStatusKind.value = 'success'
}
async function saveDoubao() {
  doubaoBusy.value = true
  doubaoStatus.value = ''
  try {
    const config = await window.electronAPI?.saveDoubaoConfig({
      apiKey: doubaoApiKey.value,
      model: doubaoModel.value,
    })
    if (!config) throw new Error('保存失败')
    doubaoHasApiKey.value = config.hasApiKey
    doubaoModel.value = config.model
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
async function testDoubao() {
  doubaoBusy.value = true
  doubaoStatus.value = '正在连接豆包…'
  doubaoStatusKind.value = 'success'
  try {
    const result = await window.electronAPI?.testDoubaoConnection({
      apiKey: doubaoApiKey.value,
      model: doubaoModel.value,
    })
    if (!result?.ok) throw new Error(result?.error || '连接失败')
    doubaoApiKey.value = ''
    doubaoHasApiKey.value = true
    doubaoStatus.value = `连接成功：${result.text || '豆包已响应'}`
    doubaoStatusKind.value = 'success'
  } catch (error) {
    doubaoStatus.value = error instanceof Error ? error.message : '连接失败'
    doubaoStatusKind.value = 'error'
  } finally {
    doubaoBusy.value = false
  }
}
function addMemory() {
  agent.addMemory(newMemory.value)
  newMemory.value = ''
}

function currentMarketConfig(): MarketBridgeConfig {
  return {
    openDHost: marketOpenDHost.value.trim(),
    openDPort: Number(marketOpenDPort.value),
    bridgeUrl: marketBridgeUrl.value.trim(),
  }
}
function applyMarketConfig(config: MarketBridgeConfig) {
  marketOpenDHost.value = config.openDHost
  marketOpenDPort.value = config.openDPort
  marketBridgeUrl.value = config.bridgeUrl
}
async function saveMarket() {
  marketBusy.value = true
  marketStatus.value = ''
  try {
    const saved = await window.electronAPI?.saveMarketConfig(currentMarketConfig())
    if (!saved) throw new Error('保存失败')
    applyMarketConfig(saved)
    marketStatus.value = '行情配置已保存'
    marketStatusKind.value = 'success'
  } catch (error) {
    marketStatus.value = error instanceof Error ? error.message : '保存失败'
    marketStatusKind.value = 'error'
  } finally {
    marketBusy.value = false
  }
}
async function testMarket() {
  await saveMarket()
  if (marketStatusKind.value === 'error') return
  marketBusy.value = true
  marketStatus.value = '正在连接 OpenD…'
  try {
    const result = await window.electronAPI?.testMarketConnection()
    if (!result?.ok) throw new Error(result?.message || '连接失败')
    marketStatus.value = result.message
    marketStatusKind.value = 'success'
  } catch (error) {
    marketStatus.value = error instanceof Error ? error.message : '连接失败'
    marketStatusKind.value = 'error'
  } finally {
    marketBusy.value = false
  }
}
function saveBackend() {
  setBackendUrl(backendUrl.value)
  setBackendToken(backendToken.value)
  backendUrl.value = getBackendUrl()
  backendStatus.value = '后端配置已保存'
  backendStatusKind.value = 'success'
}
async function testBackend() {
  saveBackend()
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
function changeMarketSource() {
  setMarketSource(marketSource.value)
  marketStatus.value = ''
  backendStatus.value = ''
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
.section { display: flex; flex-direction: column; gap: 6px; }
.section-title { color: #999; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
label { color: #bbb; font-size: 12px; }
.toggle-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.toggle-row input { width: 16px; height: 16px; margin: 0; accent-color: #6f8fbc; }
.time-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.time-row label { display: flex; flex-direction: column; gap: 5px; }
.memory-input { display: flex; gap: 6px; }
.memory-input input { min-width: 0; flex: 1; }
.memory-input button { flex: none; border: 1px solid rgba(111,143,188,.5); border-radius: 6px; color: #e0e8f4; background: rgba(111,143,188,.18); cursor: pointer; }
.memory-list { display: flex; flex-direction: column; border-top: 1px solid rgba(255,255,255,.08); }
.memory-list div { display: flex; gap: 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
.memory-list span { flex: 1; min-width: 0; color: #aaa; font-size: 11px; line-height: 1.4; }
.memory-list button { border: 0; color: #888; background: transparent; cursor: pointer; }
input, select {
  width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06); color: #eee; font-size: 12px; outline: none;
}
input:focus, select:focus { border-color: rgba(111, 143, 188, 0.72); }
input[readonly] { color: #8996a9; }
.button-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; }
.button-row button { height: 34px; border: 1px solid rgba(111,143,188,.55); border-radius: 6px; color: #e7edf6; background: rgba(85,119,167,.28); cursor: pointer; }
.button-row button:last-child { color: #fff; background: #5577a7; }
.button-row button:disabled { opacity: .5; cursor: default; }
.status { margin: 2px 0 0; font-size: 11px; line-height: 1.45; }
.status.success { color: #d7b36a; }
.status.error { color: #df8790; }
.hint { color: #666; font-size: 11px; margin: 0; }

.settings-slide-enter-active, .settings-slide-leave-active { transition: all 0.25s ease; }
.settings-slide-enter-from, .settings-slide-leave-to { opacity: 0; }
.settings-slide-enter-from .settings-panel, .settings-slide-leave-to .settings-panel { transform: translateX(40px); }
.settings-slide-enter-active .settings-panel, .settings-slide-leave-active .settings-panel { transition: transform 0.25s ease; }
</style>
