export interface PruneRendererAssetsResult {
  removedFiles: number
  removedBytes: number
}

export function pruneRendererAuthoringAssets(root: string): Promise<PruneRendererAssetsResult>
