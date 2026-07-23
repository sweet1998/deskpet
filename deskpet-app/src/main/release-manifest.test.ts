// @vitest-environment node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('macOS update manifest', () => {
  it('contains both Intel and Apple Silicon update artifacts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-release-'))
    directories.push(directory)
    for (const name of [
      'MaiMai-DeskPet-0.3.0-arm64.zip',
      'MaiMai-DeskPet-0.3.0-x64.zip',
      'MaiMai-DeskPet-0.3.0-arm64.dmg',
      'MaiMai-DeskPet-0.3.0-x64.dmg',
    ]) fs.writeFileSync(path.join(directory, name), name)

    const script = fileURLToPath(new URL('../../scripts/create-mac-update-manifest.mjs', import.meta.url))
    execFileSync(process.execPath, [script, directory, '0.3.0'])
    const manifest = fs.readFileSync(path.join(directory, 'latest-mac.yml'), 'utf-8')
    expect(manifest).toContain('MaiMai-DeskPet-0.3.0-arm64.zip')
    expect(manifest).toContain('MaiMai-DeskPet-0.3.0-x64.zip')
    expect(manifest).toContain('releaseDate:')
  })
})
