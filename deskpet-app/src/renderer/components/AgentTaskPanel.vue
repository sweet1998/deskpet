<template>
  <Transition name="task-fade">
    <section v-if="agent.taskPanelOpen" class="task-panel" data-pet-ui @mousedown.stop>
      <header>
        <div>
          <span class="eyebrow">AI Agent</span>
          <h2>{{ agent.sourceName || '当前任务' }}</h2>
        </div>
        <button class="icon-button" type="button" title="关闭" @click="agent.taskPanelOpen = false">
          <X :size="17" />
        </button>
      </header>

      <div class="task-body">
        <p class="goal">{{ agent.taskGoal || '正在处理你的请求' }}</p>

        <ol class="steps">
          <li v-for="(step, index) in steps" :key="step" :class="stepClass(index)">
            <span>{{ index + 1 }}</span>{{ step }}
          </li>
        </ol>

        <div class="progress-line">
          <div class="progress-track"><span :style="{ width: `${agent.progress}%` }" /></div>
          <strong>{{ agent.progress }}%</strong>
        </div>
        <p class="current-step">{{ agent.currentStep || '准备开始' }}</p>

        <div v-if="agent.confirmation" class="confirmation">
          <div class="warning-title"><ShieldAlert :size="17" />需要你的允许</div>
          <p>{{ agent.confirmation.summary }}</p>
          <small>操作：{{ agent.confirmation.tool }} · 风险：{{ riskLabel }}</small>
          <div class="commands">
            <button class="secondary" type="button" @click="$emit('confirm', false)">取消</button>
            <button class="primary" type="button" @click="$emit('confirm', true)">允许</button>
          </div>
        </div>

        <div v-else-if="agent.taskResult" class="result">
          <h3>{{ agent.taskResult.title }}</h3>
          <div class="result-content">{{ agent.taskResult.content }}</div>
        </div>

        <div v-else-if="agent.error" class="error-message">{{ agent.error }}</div>
      </div>

      <footer>
        <button
          v-if="agent.interruptible"
          class="secondary"
          type="button"
          @click="$emit('interrupt')"
        >
          取消任务
        </button>
        <button v-if="agent.taskResult" class="primary" type="button" @click="$emit('save')">
          <Save :size="15" /> 保存结果
        </button>
      </footer>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Save, ShieldAlert, X } from 'lucide-vue-next'
import { useAgentStore } from '@/stores/agent'

defineEmits<{
  interrupt: []
  confirm: [allowed: boolean]
  save: []
}>()

const agent = useAgentStore()
const steps = ['理解任务', '制定计划', '执行工具', '整理结果']
const riskLabel = computed(() => ({ low: '低', medium: '中', high: '高' })[agent.confirmation?.risk || 'medium'])
const activeStepIndex = computed(() => {
  if (agent.state === 'success') return steps.length
  const thresholds = [0, 20, 45, 80]
  let current = 0
  for (let index = 0; index < thresholds.length; index += 1) {
    if (agent.progress >= thresholds[index]) current = index
  }
  return current
})

function stepClass(index: number) {
  return {
    active: index === activeStepIndex.value,
    complete: index < activeStepIndex.value || agent.state === 'success',
  }
}
</script>

<style scoped>
.task-panel { position: absolute; z-index: 55; inset: 0; margin: auto; width: 460px; height: min(560px, calc(100vh - 32px)); display: flex; flex-direction: column; color: #293548; background: rgba(250,250,248,.98); border: 1px solid rgba(46,61,84,.17); border-radius: 8px; box-shadow: 0 20px 60px rgba(25,34,48,.24); backdrop-filter: blur(18px); -webkit-app-region: no-drag; }
header { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 16px 18px 13px; border-bottom: 1px solid #dce1e9; }
.eyebrow { color: #5577a7; font-size: 10px; font-weight: 700; text-transform: uppercase; }
h2 { margin: 2px 0 0; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
.icon-button { width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 6px; color: #59667a; background: transparent; cursor: pointer; }
.icon-button:hover { background: #e9edf3; }
.task-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 18px; }
.goal { margin: 0 0 14px; color: #4d596c; font-size: 13px; line-height: 1.55; }
.steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
.steps li { display: flex; flex-direction: column; gap: 5px; color: #89918f; font-size: 10px; }
.steps li span { width: 22px; height: 22px; display: grid; place-items: center; border: 1px solid #ccd5d2; border-radius: 50%; }
.steps li.active { color: #4f6f9e; font-weight: 600; }
.steps li.active span { color: #fff; border-color: #5577a7; background: #5577a7; }
.steps li.complete { color: #806631; }
.steps li.complete span { color: #fff; border-color: #c49a51; background: #c49a51; }
.progress-line { margin-top: 18px; display: flex; align-items: center; gap: 10px; }
.progress-track { flex: 1; height: 6px; overflow: hidden; background: #dfe6e4; border-radius: 3px; }
.progress-track span { display: block; height: 100%; background: #5577a7; transition: width .25s ease; }
.progress-line strong { width: 34px; color: #4d5a57; font-size: 11px; text-align: right; }
.current-step { margin: 6px 0 0; color: #77817e; font-size: 11px; }
.confirmation { margin-top: 16px; padding: 13px 14px; border: 1px solid #ead8ae; border-radius: 7px; background: #fffaf0; }
.warning-title { display: flex; align-items: center; gap: 7px; color: #7a5711; font-size: 13px; font-weight: 650; }
.confirmation p { margin: 8px 0 5px; font-size: 12px; line-height: 1.5; }
.confirmation small { color: #8f7b55; }
.result { margin-top: 16px; padding-top: 14px; border-top: 1px solid #dce1e9; }
.result h3 { margin: 0 0 9px; font-size: 13px; }
.result-content { max-height: 210px; overflow-y: auto; color: #46514e; font-size: 12px; line-height: 1.65; white-space: pre-wrap; }
.error-message { margin-top: 16px; color: #a63d3d; font-size: 12px; }
footer { min-height: 56px; flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 18px; border-top: 1px solid #dce1e9; }
.commands { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.primary, .secondary { min-height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.primary { border: 1px solid #4f6f9e; color: #fff; background: #4f6f9e; }
.secondary { border: 1px solid #cbd4d1; color: #4b5552; background: #fff; }
.task-fade-enter-active, .task-fade-leave-active { transition: opacity .2s ease; }
.task-fade-enter-from, .task-fade-leave-to { opacity: 0; }
</style>
