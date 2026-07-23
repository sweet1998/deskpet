import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readOrCreateBackendToken, resolveBackendLaunch } from './backend-manager'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-backend-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('backend launch resolution', () => {
  it('creates and reuses a private local access token', () => {
    const tokenPath = path.join(temporaryDirectory(), 'state', 'backend-token')
    const generated = 'a'.repeat(64)

    expect(readOrCreateBackendToken(tokenPath, () => generated)).toBe(generated)
    expect(readOrCreateBackendToken(tokenPath, () => 'b'.repeat(64))).toBe(generated)
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600)
  })

  it('uses the bundled backend executable in packaged apps', () => {
    const resourcesPath = temporaryDirectory()
    const executable = path.join(resourcesPath, 'backend', 'deskpet-backend')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, '')

    expect(resolveBackendLaunch({
      appPath: '/Applications/Deskpet.app/Contents/Resources/app.asar',
      resourcesPath,
      isPackaged: true,
      platform: 'darwin',
    })).toEqual({ command: executable, args: [], cwd: path.dirname(executable) })
  })

  it('prefers the repository virtual environment in development', () => {
    const root = temporaryDirectory()
    const appPath = path.join(root, 'deskpet-app')
    const backend = path.join(root, 'backend')
    const python = path.join(backend, '.venv', 'bin', 'python')
    fs.mkdirSync(path.dirname(python), { recursive: true })
    fs.mkdirSync(appPath, { recursive: true })
    fs.writeFileSync(python, '')
    fs.writeFileSync(path.join(backend, 'desktop_entry.py'), '')

    expect(resolveBackendLaunch({
      appPath,
      resourcesPath: root,
      isPackaged: false,
      platform: 'darwin',
    })).toEqual({
      command: python,
      args: [path.join(backend, 'desktop_entry.py')],
      cwd: backend,
    })
  })
})
