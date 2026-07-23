import type { ResearchPrepareResult } from '../../shared/research'

const EDUCATION_TERMS = [
  '市盈率', '市净率', 'pe', 'pb', 'peg', 'roe', 'k线', '均线', 'macd', 'rsi', '复权', '除权',
  '除息', '分红', '股息率', '换手率', '量比', '成交量', '仓位', '止损', '涨停', '跌停',
  '集合竞价', '龙虎榜', '融资融券', '基本面', '技术面',
]
const EDUCATION_QUESTIONS = ['什么是', '什么意思', '是什么意思', '怎么理解', '如何理解', '区别', '解释']
const OUT_OF_SCOPE_TERMS = [
  '天气', '气温', '下雨', '菜谱', '做饭', '翻译', '写诗', '旅游', '酒店', '机票', '编程',
  '程序', 'vue', 'react', 'javascript', 'python', '数据库', '基金', '债券', '期货', '外汇',
  '比特币', '加密货币', '美股', '港股',
]
const STOCK_SIGNALS = [
  ...EDUCATION_TERMS, '股票', '个股', '板块', '行业', '概念', '指数', '大盘', 'a股', '股市', '行情',
]

function contains(text: string, values: string[]): boolean {
  const normalized = text.toLocaleLowerCase()
  return values.some((value) => normalized.includes(value.toLocaleLowerCase()))
}

export function localStockPreparation(text: string): ResearchPrepareResult | undefined {
  const normalized = text.trim()
  if (!normalized || /(?<!\d)\d{6}(?!\d)/.test(normalized)) return undefined
  if (contains(normalized, OUT_OF_SCOPE_TERMS) && !contains(normalized, STOCK_SIGNALS)) {
    return {
      scope: 'out_of_scope',
      intent: 'out_of_scope',
      requiresResearch: false,
      targetKind: 'none',
      targets: [],
      thoughts: [],
      reply: '我是 A 股研究助手，只能回答个股、板块、指数和股票知识问题。其他问题请切换到麦麦。',
    }
  }
  if (contains(normalized, EDUCATION_TERMS) && contains(normalized, EDUCATION_QUESTIONS)) {
    return {
      scope: 'in_scope',
      intent: 'education',
      requiresResearch: false,
      targetKind: 'knowledge',
      targets: [{ kind: 'knowledge', name: '股票知识' }],
      thoughts: [],
    }
  }
  return undefined
}

export function researchContextUnavailable(prepared: ResearchPrepareResult): boolean {
  if (!prepared.context || prepared.intent === 'education') return false
  const context = prepared.context
  if (context.kind === 'security') return context.market?.status !== 'ok'
  if (context.kind === 'sector_group') {
    const sectors = Array.isArray(context.sectors) ? context.sectors : []
    return !sectors.some((sector) => sector?.status === 'ok')
  }
  return context.status === 'unavailable'
}
