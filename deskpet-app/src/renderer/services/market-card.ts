import type { ChatMarketCard, ChatMarketItem } from '@/stores/chat'
import type { ResearchPrepareResult } from '../../shared/research'

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function displayCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.replace(/^(SH|SZ|BJ)\./i, '')
}

function marketItem(value: unknown, fallbackName = '行情'): ChatMarketItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const name = typeof item.name === 'string' && item.name.trim() ? item.name : fallbackName
  return {
    ...(displayCode(item.code) ? { code: displayCode(item.code) } : {}),
    name,
    price: numberOrNull(item.price ?? item.latest ?? item.close),
    changePercent: numberOrNull(item.changePercent),
  }
}

function sourceFrom(value: Record<string, any>): string | undefined {
  const source = typeof value.source === 'string'
    ? value.source
    : value.dataSources && typeof value.dataSources.snapshot === 'string'
      ? value.dataSources.snapshot
      : undefined
  if (!source) return undefined
  const labels: Record<string, string> = {
    akshare: 'AKShare',
    'akshare-eastmoney': 'AKShare · 东方财富',
    'akshare-ths': 'AKShare · 同花顺',
    tencent: '腾讯行情',
    'tencent-public': '腾讯行情',
    eastmoney: '东方财富',
    mixed: '多源数据',
  }
  const label = labels[source]
    || (source.endsWith('-sector-proxy') ? '代表性成分股估算' : source)
  return `数据来源：${label}`
}

function card(
  title: string,
  items: Array<ChatMarketItem | null>,
  context: Record<string, any>,
): ChatMarketCard | null {
  const valid = items.filter((item): item is ChatMarketItem => Boolean(item)).slice(0, 8)
  if (!valid.length || valid.every((item) => item.price == null && item.changePercent == null)) return null
  const warnings = Array.isArray(context.warnings) ? context.warnings : []
  const note = context.marketStatus === 'closed'
    ? '已休市，展示最近可用数据'
    : context.stale === true
      ? '行情数据已超过 60 秒，请注意时效'
      : warnings[0]
  return {
    title,
    items: valid,
    ...(typeof context.asOf === 'string' ? { asOf: context.asOf } : {}),
    ...(sourceFrom(context) ? { source: sourceFrom(context) } : {}),
    ...(note ? { note: String(note).slice(0, 160) } : {}),
  }
}

export function marketCardFromResearch(prepared: ResearchPrepareResult): ChatMarketCard | null {
  if (!prepared.context || prepared.scope !== 'in_scope') return null
  const context = prepared.context

  if (context.kind === 'security') {
    const market = context.market && typeof context.market === 'object' ? context.market : {}
    const securities: unknown[] = Array.isArray(market.securities) ? market.securities : []
    return card('个股行情', securities.map((item) => marketItem(item)), {
      ...context,
      asOf: market.asOf ?? context.asOf,
      source: market.source ?? context.source,
      marketStatus: market.marketStatus ?? context.marketStatus,
      stale: securities.some((item) => Boolean(item && typeof item === 'object' && (item as Record<string, unknown>).stale)),
      warnings: context.warnings ?? market.warnings,
    })
  }

  if (context.kind === 'sector_group') {
    const sectors = Array.isArray(context.sectors) ? context.sectors : []
    return card(`${context.name || '主题'}行情`, sectors.map((sector) => {
      if (!sector || typeof sector !== 'object') return null
      return marketItem({
        name: sector.name,
        code: sector.code,
        ...(sector.snapshot || {}),
      }, '板块')
    }), context)
  }

  if (context.kind === 'sector_scan') {
    const sectors = Array.isArray(context.sectors) ? context.sectors : []
    return card('板块筛选结果', sectors.map((sector) => {
      if (!sector || typeof sector !== 'object') return null
      return marketItem({
        name: sector.name,
        code: sector.code,
        ...(sector.snapshot || {}),
      }, '板块')
    }), context)
  }

  if (context.kind === 'stock_screen') {
    const stocks = Array.isArray(context.stocks) ? context.stocks : []
    return card('个股筛选结果', stocks.map((stock) => marketItem(stock, '候选股票')), context)
  }

  if (context.kind === 'sector') {
    return card(`${context.name || '板块'}行情`, [marketItem({
      name: context.name,
      code: context.code,
      ...(context.snapshot || {}),
    }, '板块')], context)
  }

  if (context.kind === 'index') {
    return card('指数行情', [marketItem({
      name: context.name,
      code: context.code,
      ...(context.snapshot || {}),
    }, '指数')], context)
  }

  if (context.kind === 'market') {
    const indices = Array.isArray(context.indices) ? context.indices : []
    return card('A 股主要指数', indices.map((item) => marketItem(item, '指数')), context)
  }

  return null
}
