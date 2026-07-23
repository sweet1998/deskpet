// @vitest-environment node

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('macOS release configuration', () => {
  it('keeps privacy usage descriptions inside the mac configuration', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'))
    expect(packageJson.build.extendInfo).toBeUndefined()
    expect(packageJson.build.mac.extendInfo).toMatchObject({
      NSMicrophoneUsageDescription: expect.any(String),
      NSSpeechRecognitionUsageDescription: expect.any(String),
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/native/deskpet-ocr',
      to: 'native/deskpet-ocr',
    })
    expect(packageJson.build.extraResources).toContainEqual({ from: '../PRIVACY.md', to: 'PRIVACY.md' })
    expect(packageJson.build.extraResources).toContainEqual({ from: '../TERMS.md', to: 'TERMS.md' })
  })

  it('requires a clean tagged commit and explicit Live2D distribution approval', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'))
    const envCheck = fs.readFileSync(path.resolve(process.cwd(), 'scripts/check-release-env.mjs'), 'utf-8')
    const versionCheck = fs.readFileSync(path.resolve(process.cwd(), 'scripts/check-release-version.mjs'), 'utf-8')

    expect(packageJson.scripts['dist:mac']).toContain('check-release-git-state.mjs')
    expect(envCheck).toContain('LIVE2D_DISTRIBUTION_CONFIRMED')
    expect(versionCheck).toContain("['rev-list', '-n', '1', expectedTag]")
  })

  it('builds signed releases on dedicated arm64 and Intel runners', () => {
    const workflow = fs.readFileSync(path.resolve(process.cwd(), '../.github/workflows/release.yml'), 'utf-8')
    expect(workflow).toContain('runner: macos-14')
    expect(workflow).toContain('runner: macos-15-intel')
    expect(workflow).toContain('LIVE2D_DISTRIBUTION_CONFIRMED')
  })
})
