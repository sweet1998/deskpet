<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { DOWN_COLOR, UP_COLOR, toCandles, toMovingAverage } from '@/services/chart/candles'
import { volumeBars } from '@/services/chart/volume'
import { curveIsPartial, toEquityCurve } from '@/services/chart/equity-curve'
import { chartLayout } from '@/services/chart/preview-metrics'
import type { ChartSeries } from '@/services/chart/series-store'

const props = defineProps<{ series: ChartSeries; expanded?: boolean }>()

const host = ref<HTMLDivElement | null>(null)
const failed = ref(false)
const partial = ref(false)
const chart = shallowRef<any>(null)
let disposed = false
let resizeObserver: ResizeObserver | null = null
let resizeFrameId = 0

const PANEL_BACKGROUND = '#fcfcfa'
const AXIS_COLOR = '#8791a2'
const GRID_COLOR = '#eef1f5'
const EQUITY_COLOR = '#5577a7'
const BENCHMARK_COLOR = '#a9b3c1'
const MA5_COLOR = '#cf8a36'
const MA20_COLOR = '#4f78a8'
const MA30_COLOR = '#3c8a7a'

function destroy(): void {
  try {
    chart.value?.remove()
  } catch {
    // The chart is already gone; nothing to release.
  }
  chart.value = null
}

function syncSize(): void {
  const container = host.value
  const instance = chart.value
  if (!container || !instance) return
  const width = container.clientWidth
  const height = container.clientHeight
  if (!width || !height) return
  instance.resize(width, height)
  instance.timeScale().fitContent()
}

function scheduleSizeSync(): void {
  if (resizeFrameId) cancelAnimationFrame(resizeFrameId)
  resizeFrameId = requestAnimationFrame(() => {
    resizeFrameId = 0
    if (chart.value) {
      syncSize()
      return
    }
    void render()
  })
}

async function render(): Promise<void> {
  const container = host.value
  if (!container) return
  const width = container.clientWidth
  const height = container.clientHeight
  if (!width || !height) {
    scheduleSizeSync()
    return
  }
  destroy()
  failed.value = false
  partial.value = false

  const layout = chartLayout(width, Boolean(props.expanded))

  try {
    const lib = await import('lightweight-charts')
    if (disposed || !host.value) return

    const instance = lib.createChart(container, {
      width,
      height,
      autoSize: false,
      layout: {
        background: { color: PANEL_BACKGROUND },
        textColor: AXIS_COLOR,
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: layout.showAxes, color: GRID_COLOR },
        horzLines: { visible: layout.showAxes, color: GRID_COLOR },
      },
      rightPriceScale: { visible: layout.showAxes, borderColor: GRID_COLOR },
      timeScale: { visible: layout.showAxes, borderColor: GRID_COLOR, fixLeftEdge: true },
      crosshair: { mode: layout.showAxes ? 0 : 2 },
      // The chat list scrolls; wheel-zoom here would trap the scroll gesture.
      handleScroll: layout.showAxes,
      handleScale: layout.showAxes,
    })

    if (props.series.kind === 'equity') {
      const { equity, benchmark } = toEquityCurve(props.series.curve)
      if (!equity.length) throw new Error('empty curve')
      partial.value = curveIsPartial(equity.length, props.series.rebalanceCount)
      instance.addSeries(lib.LineSeries, {
        color: EQUITY_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: layout.showAxes,
      }).setData(equity)
      if (benchmark.length) {
        instance.addSeries(lib.LineSeries, {
          color: BENCHMARK_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        }).setData(benchmark)
      }
    } else {
      const allCandles = toCandles(props.series.bars, 0)
      const candles = layout.barLimit > 0 ? allCandles.slice(-layout.barLimit) : allCandles
      if (!candles.length) throw new Error('empty candles')
      const visibleTimes = new Set(candles.map((item) => item.time))
      instance.addSeries(lib.CandlestickSeries, {
        upColor: UP_COLOR,
        downColor: DOWN_COLOR,
        wickUpColor: UP_COLOR,
        wickDownColor: DOWN_COLOR,
        borderUpColor: UP_COLOR,
        borderDownColor: DOWN_COLOR,
        priceLineVisible: false,
        lastValueVisible: layout.showAxes,
      }).setData(candles)

      for (const [period, color] of [[5, MA5_COLOR], [20, MA20_COLOR], [30, MA30_COLOR]] as const) {
        const average = toMovingAverage(allCandles, period).filter((point) => visibleTimes.has(point.time))
        if (!average.length) continue
        instance.addSeries(lib.LineSeries, {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }).setData(average)
      }

      if (layout.showVolume) {
        const volume = volumeBars(props.series.bars, layout.barLimit)
        if (volume.length) {
          const series = instance.addSeries(lib.HistogramSeries, {
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
            lastValueVisible: false,
          })
          series.setData(volume)
          instance.priceScale('volume').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } })
        }
      }
    }

    instance.timeScale().fitContent()
    chart.value = instance
    scheduleSizeSync()
  } catch {
    // A malformed series must not take the surrounding chat panel down with it.
    destroy()
    failed.value = true
  }
}

/** Repaint after a display change: the canvas would stay blurry on a different DPR. */
function refresh(): void {
  syncSize()
  chart.value?.applyOptions({})
}

onMounted(() => {
  void render()
  if (host.value) {
    resizeObserver = new ResizeObserver(() => {
      scheduleSizeSync()
    })
    resizeObserver.observe(host.value)
  }
  window.addEventListener('resize', refresh)
})

onBeforeUnmount(() => {
  disposed = true
  if (resizeFrameId) cancelAnimationFrame(resizeFrameId)
  resizeFrameId = 0
  resizeObserver?.disconnect()
  resizeObserver = null
  window.removeEventListener('resize', refresh)
  destroy()
})

watch(() => [props.series, props.expanded], () => {
  void render()
})
</script>

<template>
  <div class="stock-chart" :class="{ expanded }" data-pet-ui>
    <div v-show="!failed" ref="host" class="stock-chart-canvas" :class="{ expanded }" />
    <p v-if="failed" class="stock-chart-fallback">图表数据不完整，无法绘制。</p>
    <p v-else-if="partial" class="stock-chart-note">曲线数据不完整，仅展示已返回的区间。</p>
  </div>
</template>

<style scoped>
.stock-chart { width: 100%; }
.stock-chart.expanded {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.stock-chart-canvas {
  width: 100%;
  aspect-ratio: 16 / 9;
  border: 1px solid #e2e6ec;
  border-radius: 6px;
  overflow: hidden;
  background: #fcfcfa;
}
.stock-chart-canvas.expanded {
  aspect-ratio: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.stock-chart-fallback, .stock-chart-note {
  margin: 4px 0 0;
  color: #8791a2;
  font-size: 11px;
}
</style>
