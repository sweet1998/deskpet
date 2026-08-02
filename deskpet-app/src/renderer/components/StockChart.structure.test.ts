// @vitest-environment node

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

function sfc(relative: string) {
  const { descriptor } = parse(read(relative))
  return {
    template: descriptor.template?.content ?? '',
    scriptSetup: descriptor.scriptSetup?.content ?? '',
    styles: descriptor.styles.map((style) => style.content).join('\n'),
  }
}

describe('StockChart', () => {
  const chart = sfc('./StockChart.vue')

  it('loads the chart library lazily so jsdom tests never construct a chart', () => {
    expect(chart.scriptSetup).toContain("await import('lightweight-charts')")
    expect(chart.scriptSetup).not.toMatch(/^import .*from 'lightweight-charts'/m)
  })

  it('keeps the container hit-testable and fluid', () => {
    expect(chart.template).toContain('data-pet-ui')
    expect(chart.template).toContain(':class="{ expanded }"')
    expect(chart.styles).toContain('width: 100%')
    expect(chart.styles).toContain('.stock-chart.expanded')
    expect(chart.styles).toContain('height: 100%')
    expect(chart.styles).not.toMatch(/width:\s*260px/)
  })

  it('never lets the chart hijack the chat scroll in the inline preview', () => {
    expect(chart.scriptSetup).toContain('handleScroll: layout.showAxes')
    expect(chart.scriptSetup).toContain('handleScale: layout.showAxes')
  })

  it('reflows when the chat surface is reopened or resized', () => {
    expect(chart.scriptSetup).toContain('new ResizeObserver')
    expect(chart.scriptSetup).toContain('instance.resize(width, height)')
    expect(chart.scriptSetup).toContain('instance.timeScale().fitContent()')
    expect(chart.scriptSetup).toContain('autoSize: false')
  })

  it('computes moving averages from the full stored history, not only visible bars', () => {
    expect(chart.scriptSetup).toContain('const allCandles = toCandles(props.series.bars, 0)')
    expect(chart.scriptSetup).toContain('const visibleTimes = new Set(candles.map((item) => item.time))')
    expect(chart.scriptSetup).toContain('toMovingAverage(allCandles, period).filter((point) => visibleTimes.has(point.time))')
  })

  it('hides the attribution logo, which would link out of an offline app', () => {
    expect(chart.scriptSetup).toContain('attributionLogo: false')
  })

  it('paints an opaque background inside the transparent window', () => {
    expect(chart.scriptSetup).toContain('const PANEL_BACKGROUND = ')
    expect(chart.scriptSetup).not.toContain("background: { color: 'transparent' }")
  })

  it('degrades instead of taking the chat panel down with it', () => {
    expect(chart.scriptSetup).toContain('} catch {')
    expect(chart.scriptSetup).toContain('failed.value = true')
  })

  it('uses the A-share palette rather than the library default', () => {
    expect(chart.scriptSetup).toContain('upColor: UP_COLOR')
    expect(chart.scriptSetup).toContain('downColor: DOWN_COLOR')
  })
})

describe('StockChartOverlay', () => {
  const overlay = sfc('./StockChartOverlay.vue')

  it('is dismissible with Escape', () => {
    expect(overlay.scriptSetup).toContain("event.key === 'Escape'")
    expect(overlay.scriptSetup).toContain("window.addEventListener('keydown', onKeydown)")
    expect(overlay.scriptSetup).toContain("window.removeEventListener('keydown', onKeydown)")
  })

  it('adds no full-screen backdrop, which would trap clicks across the desktop', () => {
    expect(overlay.template).toContain('data-pet-ui')
    expect(overlay.styles).not.toContain('width: 100vw')
    expect(overlay.styles).not.toContain('height: 100vh')
    expect(overlay.template).not.toContain('chart-overlay-backdrop')
  })

  it('labels the backtest benchmark without claiming it is an index', () => {
    expect(overlay.template).toContain('benchmarkLabel')
    expect(overlay.template).not.toContain('沪深300')
  })
})

describe('DeskpetStage chart overlay wiring', () => {
  const stage = sfc('./DeskpetStage.vue')

  it('keeps the window expanded while the overlay is open', () => {
    expect(stage.scriptSetup).toMatch(/expandedUiOpen = computed[\s\S]*expandedChart\.value/)
  })

  it('does not add a third pet window layout mode', () => {
    expect(stage.scriptSetup).toContain("const mode = expandedUiOpen.value ? 'settings' : 'compact'")
    expect(stage.scriptSetup).not.toContain("'chart'")
  })
})

describe('chart series storage', () => {
  it('keeps series in memory only, never on the persisted market card', () => {
    const store = read('../services/chart/series-store.ts')
    expect(store).toContain('const seriesByRequest = new Map')

    const chatStore = read('../stores/chat.ts')
    const sanitizer = chatStore.match(/function sanitizeMarketCard[\s\S]*?\n}/)?.[0] ?? ''
    expect(sanitizer).not.toContain('dailyBars')
    expect(sanitizer).not.toContain('curve')
  })

  it('renders a metrics-only card such as a backtest', () => {
    const chatStore = read('../stores/chat.ts')
    expect(chatStore).toContain('!card.items.length && !card.metrics?.length')
  })
})
