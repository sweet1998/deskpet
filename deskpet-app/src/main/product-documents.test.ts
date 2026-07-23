// @vitest-environment node
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveProductDocumentPath } from './product-documents'

describe('local product documents', () => {
  it('opens bundled policy files in packaged builds', () => {
    const expected = path.join('/Applications/MaiMai.app/Contents/Resources', 'PRIVACY.md')
    expect(resolveProductDocumentPath('privacy', {
      appPath: '/Applications/MaiMai.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/MaiMai.app/Contents/Resources',
      isPackaged: true,
    }, (filePath) => filePath === expected)).toBe(expected)
  })

  it('opens repository policy files while developing', () => {
    const expected = path.resolve('/repo/deskpet-app', '..', 'TERMS.md')
    expect(resolveProductDocumentPath('terms', {
      appPath: '/repo/deskpet-app',
      resourcesPath: '/tmp/electron',
      isPackaged: false,
    }, (filePath) => filePath === expected)).toBe(expected)
  })
})
