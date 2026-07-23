import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DoubaoCapabilityReport,
  DoubaoConfigInput,
  DoubaoConfigView,
} from '../../shared/doubao'

const EMPTY_CONFIG: DoubaoConfigView = {
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: '',
  hasApiKey: false,
}

export const useAiConfigStore = defineStore('ai-config', () => {
  const config = ref<DoubaoConfigView>({ ...EMPTY_CONFIG })
  const loaded = ref(false)

  const ready = computed(() => config.value.hasApiKey && Boolean(config.value.model))
  const capabilitiesChecked = computed(() => Boolean(config.value.capabilities?.checkedAt))
  const textSupported = computed(() => config.value.capabilities?.text === true)
  const streamingSupported = computed(() => config.value.capabilities?.streaming === true)
  const visionSupported = computed(() => config.value.capabilities?.vision === true)

  async function load(): Promise<DoubaoConfigView> {
    const value = await window.electronAPI?.getDoubaoConfig()
    if (value) config.value = value
    loaded.value = true
    return config.value
  }

  async function save(input: DoubaoConfigInput): Promise<DoubaoConfigView> {
    const value = await window.electronAPI?.saveDoubaoConfig(input)
    if (!value) throw new Error('保存 AI 配置失败')
    config.value = value
    loaded.value = true
    return value
  }

  async function detect(input: DoubaoConfigInput): Promise<DoubaoCapabilityReport> {
    const report = await window.electronAPI?.detectDoubaoCapabilities(input)
    if (!report) throw new Error('无法检测模型能力')
    const latest = await load()
    config.value = { ...latest, capabilities: report }
    return report
  }

  async function clear(): Promise<void> {
    if (!await window.electronAPI?.clearDoubaoConfig()) throw new Error('删除 AI 凭据失败')
    config.value = { ...EMPTY_CONFIG }
    loaded.value = true
  }

  return {
    config,
    loaded,
    ready,
    capabilitiesChecked,
    textSupported,
    streamingSupported,
    visionSupported,
    load,
    save,
    detect,
    clear,
  }
})
