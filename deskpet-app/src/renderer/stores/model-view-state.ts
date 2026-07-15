export interface PersistedModelViewState {
  zoom: number
  offsetX: number
  offsetY: number
}

export const DEFAULT_MODEL_VIEW_STATE: PersistedModelViewState = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0
}

export function migratePersistedModelViewState(
  value: unknown
): PersistedModelViewState {
  const persisted =
    value !== null && typeof value === 'object'
      ? (value as Partial<PersistedModelViewState>)
      : {}

  return {
    zoom:
      typeof persisted.zoom === 'number' && Number.isFinite(persisted.zoom)
        ? persisted.zoom
        : DEFAULT_MODEL_VIEW_STATE.zoom,
    offsetX: 0,
    offsetY: 0
  }
}
