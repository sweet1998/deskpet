export interface PetWindowInteractionState {
  dragActive: boolean
  pointOverModel: boolean
  settingsOpen: boolean
  pointOverSettings: boolean
}

export function shouldPetWindowBeInteractive({
  dragActive,
  pointOverModel,
  settingsOpen,
  pointOverSettings,
}: PetWindowInteractionState): boolean {
  return dragActive || pointOverModel || (settingsOpen && pointOverSettings)
}
