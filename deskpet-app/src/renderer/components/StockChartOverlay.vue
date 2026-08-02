<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import StockChart from './StockChart.vue'
import type { ChartSeries } from '@/services/chart/series-store'

const props = defineProps<{ series: ChartSeries }>()
const emit = defineEmits<{ close: [] }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!--
    No full-screen backdrop: the window spans the whole work area while the chat is
    open, so a covering element would turn the entire desktop into a click trap.
  -->
  <div class="chart-overlay" data-pet-ui>
    <div class="chart-overlay-header">
      <span>{{ props.series.title }}</span>
      <button type="button" @click="emit('close')">关闭</button>
    </div>
    <div class="chart-overlay-body">
      <StockChart :series="props.series" expanded />
    </div>
    <p v-if="props.series.kind === 'equity'" class="chart-overlay-legend">
      <span class="swatch equity" />策略净值
      <span class="swatch benchmark" />{{ props.series.benchmarkLabel || '基准' }}
    </p>
  </div>
</template>

<style scoped>
.chart-overlay {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 80;
  width: 720px;
  max-width: calc(100vw - 40px);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid #cfd7e2;
  border-radius: 10px;
  background: rgba(252, 252, 250, 0.98);
  box-shadow: 0 12px 32px rgba(41, 53, 72, 0.18);
}
.chart-overlay-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #293548;
  font-size: 13px;
  font-weight: 600;
}
.chart-overlay-header button {
  padding: 3px 10px;
  border: 1px solid #cfd7e2;
  border-radius: 5px;
  color: #5577a7;
  background: #f8f9fb;
  cursor: pointer;
  font-size: 11px;
}
.chart-overlay-body { height: 420px; max-height: calc(100vh - 140px); }
.chart-overlay-legend {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: #7f8998;
  font-size: 11px;
}
.swatch { width: 14px; height: 2px; display: inline-block; }
.swatch.equity { background: #5577a7; }
.swatch.benchmark { background: #a9b3c1; }
.swatch.benchmark:not(:first-child) { margin-left: 8px; }
</style>
