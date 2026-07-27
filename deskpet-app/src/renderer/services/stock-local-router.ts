import type { ResearchPrepareResult } from '../../shared/research'

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
