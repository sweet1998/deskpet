import { spawn, type ChildProcess } from 'node:child_process'

const FRONTMOST_APP_SCRIPT = `
ObjC.import('AppKit');
let last = '';
while (true) {
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const bundle = front ? ObjC.unwrap(front.bundleIdentifier) : '';
  if (bundle && bundle !== last) {
    console.log(bundle);
    last = bundle;
  }
  delay(0.4);
}
`

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/

export function normalizeFrontmostBundleId(line: string): string | null {
  const value = line.trim()
  return BUNDLE_ID_PATTERN.test(value) ? value : null
}

export function desktopVisibilityForBundle(
  bundleId: string,
  ownBundleIds: ReadonlySet<string>,
): boolean | null {
  if (bundleId === 'com.apple.finder' || ownBundleIds.has(bundleId)) return true
  if (bundleId === 'com.apple.dock') return null
  return false
}

export class FrontmostAppMonitor {
  private child: ChildProcess | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private active = false
  private callback: ((bundleId: string) => void) | null = null
  private stdoutBuffer = ''
  private stderrBuffer = ''

  start(callback: (bundleId: string) => void): void {
    this.stop()
    if (process.platform !== 'darwin') return
    this.active = true
    this.callback = callback
    this.launch()
  }

  stop(): void {
    this.active = false
    this.callback = null
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill('SIGTERM')
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
  }

  private launch(): void {
    if (!this.active || this.child) return
    const child = spawn('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      FRONTMOST_APP_SCRIPT,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stdout?.on('data', (chunk) => this.consume('stdout', String(chunk)))
    child.stderr?.on('data', (chunk) => this.consume('stderr', String(chunk)))
    child.once('exit', () => {
      if (this.child === child) this.child = null
      if (!this.active) return
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        this.launch()
      }, 2_000)
    })
    child.once('error', () => {
      if (this.child === child) this.child = null
    })
  }

  private consume(source: 'stdout' | 'stderr', chunk: string): void {
    const pending = `${source === 'stdout' ? this.stdoutBuffer : this.stderrBuffer}${chunk}`
    const lines = pending.split(/\r?\n/)
    const rest = lines.pop() || ''
    if (source === 'stdout') this.stdoutBuffer = rest
    else this.stderrBuffer = rest
    for (const line of lines) {
      const bundleId = normalizeFrontmostBundleId(line)
      if (bundleId) this.callback?.(bundleId)
    }
  }
}
