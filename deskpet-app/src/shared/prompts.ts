import contract from './prompt-contract.json'
import { getRoleProfile, type RoleId } from './roles'

type TemplateValues = Record<string, string | number>

export interface PromptResearchInput {
  intent: string
  skills?: string[]
  context?: unknown
}

export interface RoleSystemPromptInput {
  roleId: RoleId
  dateContext: string
  userName?: string
  memories?: string[]
  research?: PromptResearchInput
}

export interface PromptTradingCalendar {
  source?: string
  today: { date: string; weekday: string; isTradingDay: boolean }
  tomorrow: { date: string; weekday: string; isTradingDay: boolean }
  nextTradingDay?: { date: string; weekday: string } | null
}

function render(template: string, values: TemplateValues): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, key: string) => (
    Object.hasOwn(values, key) ? String(values[key]) : match
  ))
}

export const PROMPT_CONTRACT_VERSION = contract.version
export const STOCK_ROUTE_SYSTEM_PROMPT = [
  contract.stockRouter.systemPrompt,
  contract.stockClarificationRouting,
].join('\n')
export const COMPLETION_MARKER = contract.completion.marker
export const COMPLETION_INSTRUCTION = render(contract.completion.instructionTemplate, {
  marker: COMPLETION_MARKER,
})
export const CONTINUATION_PROMPT = render(contract.completion.continuationTemplate, {
  marker: COMPLETION_MARKER,
})
export const COMPLETION_VERIFIER_PROMPT = contract.completion.verifierPrompt

export function currentDatePrompt(date: string): string {
  return render(contract.date.currentTemplate, {
    date,
    relativeTimeRule: contract.date.relativeTimeRule,
  })
}

export function tradingCalendarPrompt(calendar: PromptTradingCalendar): string {
  const parts = [
    render(contract.date.calendarTodayTemplate, {
      date: calendar.today.date,
      weekday: calendar.today.weekday,
      source: calendar.source || 'akshare',
    }),
    render(contract.date.calendarTradingTemplate, {
      todayTrading: calendar.today.isTradingDay ? '是' : '不是',
      tomorrowDate: calendar.tomorrow.date,
      tomorrowWeekday: calendar.tomorrow.weekday,
      tomorrowTrading: calendar.tomorrow.isTradingDay ? '是' : '不是',
    }),
  ]
  if (calendar.nextTradingDay) {
    parts.push(render(contract.date.nextTradingDayTemplate, calendar.nextTradingDay))
  }
  parts.push(contract.date.relativeTimeRule)
  return parts.join('')
}

export function researchPrompt(input: PromptResearchInput): string {
  const lines = [
    render(contract.research.intentTemplate, { intent: input.intent }),
    ...(input.skills?.length
      ? [render(contract.research.skillsTemplate, { skills: input.skills.join(', ') })]
      : []),
    ...contract.research.baseInstructions,
  ]
  if (input.context !== undefined && input.context !== null) {
    lines.push(...contract.research.contextInstructions, JSON.stringify(input.context))
  } else {
    const instruction = contract.research.intentInstructions[
      input.intent as keyof typeof contract.research.intentInstructions
    ]
    if (instruction) lines.push(instruction)
  }
  return lines.join('\n')
}

export function roleSystemPrompt(input: RoleSystemPromptInput): string {
  const profile = getRoleProfile(input.roleId)
  const lines = [
    profile.systemPrompt,
    input.dateContext,
    render(contract.system.responseStyleTemplate, { responseStyle: profile.responseStyle }),
  ]
  if (input.userName) {
    lines.push(render(contract.system.userNameTemplate, { userName: input.userName }))
  }
  if (input.memories?.length) {
    lines.push(render(contract.system.memoriesTemplate, { memories: input.memories.join('；') }))
  }
  if (input.roleId === 'stock_expert' && input.research) {
    lines.push(researchPrompt(input.research))
  }
  return lines.join('\n')
}
