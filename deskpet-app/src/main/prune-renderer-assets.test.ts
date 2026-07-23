// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneRendererAuthoringAssets } from '../../scripts/prune-renderer-assets.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe('renderer asset pruning', () => {
  it('removes Live2D authoring files while preserving runtime assets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deskpet-assets-'))
    temporaryDirectories.push(root)
    await mkdir(path.join(root, 'runtime'), { recursive: true })
    await writeFile(path.join(root, 'model.cmo3'), Buffer.alloc(32))
    await writeFile(path.join(root, 'model.can3'), Buffer.alloc(16))
    await writeFile(path.join(root, 'runtime', 'model.moc3'), 'runtime')
    await writeFile(path.join(root, 'runtime', 'model3.json'), '{}')

    await expect(pruneRendererAuthoringAssets(root)).resolves.toEqual({
      removedFiles: 2,
      removedBytes: 48,
    })
    await expect(readFile(path.join(root, 'runtime', 'model.moc3'), 'utf8')).resolves.toBe('runtime')
    await expect(readFile(path.join(root, 'runtime', 'model3.json'), 'utf8')).resolves.toBe('{}')
  })
})
