import fs from 'node:fs'
import path from 'node:path'

export type ProductDocumentKind = 'privacy' | 'terms'

const DOCUMENT_NAMES: Record<ProductDocumentKind, string> = {
  privacy: 'PRIVACY.md',
  terms: 'TERMS.md',
}

export function resolveProductDocumentPath(
  kind: ProductDocumentKind,
  options: { appPath: string; resourcesPath: string; isPackaged: boolean },
  exists: (filePath: string) => boolean = fs.existsSync,
): string | null {
  const name = DOCUMENT_NAMES[kind]
  if (!name) return null
  const candidates = options.isPackaged
    ? [path.join(options.resourcesPath, name)]
    : [path.resolve(options.appPath, '..', name), path.join(options.resourcesPath, name)]
  return candidates.find(exists) ?? null
}
