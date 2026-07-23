import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { NativeReminder } from '../shared/native-tools'

const AGENT_LABEL = 'com.sweet1998.deskpet.reminders'
const PENDING_SUFFIX = '.pending.json'
const RECEIPT_SUFFIX = '.delivered.json'
const CANCELLED_SUFFIX = '.cancelled'
const REMINDER_POLL_SECONDS = 10

type CommandRunner = (
  command: string,
  args: string[],
) => Pick<SpawnSyncReturns<string>, 'status' | 'error'>

export interface PersistentReminderScheduler {
  schedule(reminder: NativeReminder): boolean
  tryClaim(id: string): boolean
  complete(id: string): void
  cancel(id: string): void
  clear(ids: string[]): void
  consumeDelivered(): Set<string>
}

function safeId(id: string): string {
  return /^[a-zA-Z0-9-]{1,100}$/.test(id) ? id : ''
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function writeAtomic(filePath: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, content, { mode })
  fs.renameSync(temporary, filePath)
  fs.chmodSync(filePath, mode)
}

export function reminderWorkerSource(): string {
  return `ObjC.import('Foundation');

function text(value) {
  return value == null ? '' : String(ObjC.unwrap(value));
}

function exists(manager, filePath) {
  return Boolean(manager.fileExistsAtPath($(filePath)));
}

function remove(manager, filePath) {
  if (exists(manager, filePath)) manager.removeItemAtPathError($(filePath), null);
}

function readJson(filePath) {
  const data = $.NSData.dataWithContentsOfFile($(filePath));
  if (!data) return null;
  const value = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  if (!value) return null;
  try { return JSON.parse(text(value)); } catch (_) { return null; }
}

function writeJson(filePath, value) {
  const content = $(JSON.stringify(value));
  return Boolean(content.writeToFileAtomicallyEncodingError(
    $(filePath), true, $.NSUTF8StringEncoding, null
  ));
}

function run(argv) {
  const root = String(argv[0] || '');
  if (!root) return;
  const manager = $.NSFileManager.defaultManager;
  const namesValue = manager.contentsOfDirectoryAtPathError($(root), null);
  if (!namesValue) return;
  const names = ObjC.unwrap(namesValue).map(text);
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;

  names.filter(name => name.endsWith('${PENDING_SUFFIX}')).forEach(name => {
    const id = name.slice(0, -${PENDING_SUFFIX.length});
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) return;
    const pending = root + '/' + name;
    const claim = root + '/' + id + '.worker.claim';
    const cancelled = root + '/' + id + '${CANCELLED_SUFFIX}';
    const receipt = root + '/' + id + '${RECEIPT_SUFFIX}';
    if (!manager.moveItemAtPathToPathError($(pending), $(claim), null)) return;

    if (exists(manager, cancelled)) {
      remove(manager, claim);
      remove(manager, cancelled);
      return;
    }

    const reminder = readJson(claim);
    if (!reminder || reminder.id !== id || reminder.status !== 'scheduled') {
      remove(manager, claim);
      return;
    }
    if (Number(reminder.dueAt) > Date.now()) {
      manager.moveItemAtPathToPathError($(claim), $(pending), null);
      return;
    }
    if (exists(manager, cancelled)) {
      remove(manager, claim);
      remove(manager, cancelled);
      return;
    }

    try {
      app.displayNotification(String(reminder.body || '提醒时间到了'), {
        withTitle: String(reminder.title || '麦麦提醒')
      });
      if (writeJson(receipt, { id: id, deliveredAt: Date.now() })) remove(manager, claim);
      else manager.moveItemAtPathToPathError($(claim), $(pending), null);
    } catch (_) {
      manager.moveItemAtPathToPathError($(claim), $(pending), null);
    }
  });
}
`
}

function launchAgentPlist(scriptPath: string, queuePath: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/osascript</string>
    <string>-l</string>
    <string>JavaScript</string>
    <string>${xml(scriptPath)}</string>
    <string>${xml(queuePath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${REMINDER_POLL_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`
}

export class MacPersistentReminderScheduler implements PersistentReminderScheduler {
  private readonly queuePath: string
  private readonly scriptPath: string
  private readonly plistPath: string
  private readonly logPath: string
  private readonly domain: string
  private loaded = false
  private claims = new Map<string, string>()

  constructor(
    rootPath: string,
    launchAgentsPath: string,
    userId = typeof process.getuid === 'function' ? process.getuid() : -1,
    private readonly runCommand: CommandRunner = (command, args) => spawnSync(command, args, {
      encoding: 'utf-8',
      stdio: 'ignore',
    }),
  ) {
    this.queuePath = path.join(rootPath, 'queue')
    this.scriptPath = path.join(rootPath, 'reminder-worker.js')
    this.logPath = path.join(rootPath, 'reminder-worker.log')
    this.plistPath = path.join(launchAgentsPath, `${AGENT_LABEL}.plist`)
    this.domain = `gui/${userId}`
    this.cleanupOldMarkers()
  }

  schedule(reminder: NativeReminder): boolean {
    const id = safeId(reminder.id)
    if (!id) return false
    try {
      fs.rmSync(this.cancelledPath(id), { force: true })
      writeAtomic(this.pendingPath(id), JSON.stringify(reminder))
      if (this.ensureAgent()) return true
      fs.rmSync(this.pendingPath(id), { force: true })
      return false
    } catch {
      try { fs.rmSync(this.pendingPath(id), { force: true }) } catch { /* ignore cleanup */ }
      return false
    }
  }

  tryClaim(value: string): boolean {
    const id = safeId(value)
    if (!id) return false
    const claim = path.join(this.queuePath, `${id}.app-${process.pid}.claim`)
    try {
      fs.renameSync(this.pendingPath(id), claim)
      this.claims.set(id, claim)
      return true
    } catch {
      return false
    }
  }

  complete(value: string): void {
    const id = safeId(value)
    if (!id) return
    const claim = this.claims.get(id)
    if (claim) {
      try { fs.rmSync(claim, { force: true }) } catch { /* worker owns cleanup */ }
      this.claims.delete(id)
    }
    try { fs.rmSync(this.pendingPath(id), { force: true }) } catch { /* already claimed */ }
    try { fs.rmSync(this.receiptPath(id), { force: true }) } catch { /* already consumed */ }
    this.disableIfIdle()
  }

  cancel(value: string): void {
    const id = safeId(value)
    if (!id) return
    try {
      writeAtomic(this.cancelledPath(id), String(Date.now()))
      fs.rmSync(this.pendingPath(id), { force: true })
      const claim = this.claims.get(id)
      if (claim) fs.rmSync(claim, { force: true })
      this.claims.delete(id)
      fs.rmSync(this.receiptPath(id), { force: true })
    } catch { /* cancellation is also preserved by the main reminder store */ }
    this.disableIfIdle()
  }

  clear(ids: string[]): void {
    for (const id of ids) this.cancel(id)
  }

  consumeDelivered(): Set<string> {
    const delivered = new Set<string>()
    let names: string[] = []
    try { names = fs.readdirSync(this.queuePath) } catch { return delivered }
    for (const name of names) {
      if (!name.endsWith(RECEIPT_SUFFIX)) continue
      const id = safeId(name.slice(0, -RECEIPT_SUFFIX.length))
      if (!id) continue
      try {
        const receipt = JSON.parse(fs.readFileSync(path.join(this.queuePath, name), 'utf-8'))
        if (receipt?.id !== id || !Number.isFinite(receipt?.deliveredAt)) continue
        delivered.add(id)
        fs.rmSync(path.join(this.queuePath, name), { force: true })
        fs.rmSync(this.cancelledPath(id), { force: true })
      } catch { /* leave malformed receipts for diagnostics */ }
    }
    this.disableIfIdle()
    return delivered
  }

  private ensureAgent(): boolean {
    if (this.loaded) return true
    try {
      fs.mkdirSync(this.queuePath, { recursive: true, mode: 0o700 })
      fs.mkdirSync(path.dirname(this.plistPath), { recursive: true })
      writeAtomic(this.scriptPath, reminderWorkerSource())
      writeAtomic(this.plistPath, launchAgentPlist(this.scriptPath, this.queuePath, this.logPath), 0o600)
      this.runCommand('/bin/launchctl', ['bootout', `${this.domain}/${AGENT_LABEL}`])
      const result = this.runCommand('/bin/launchctl', ['bootstrap', this.domain, this.plistPath])
      this.loaded = result.status === 0 && !result.error
      return this.loaded
    } catch {
      return false
    }
  }

  private cleanupOldMarkers(): void {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(this.queuePath, { withFileTypes: true }) } catch { return }
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(CANCELLED_SUFFIX)) continue
      const filePath = path.join(this.queuePath, entry.name)
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.rmSync(filePath, { force: true })
      } catch { /* best-effort housekeeping */ }
    }
  }

  private disableIfIdle(): void {
    let names: string[] = []
    try { names = fs.readdirSync(this.queuePath) } catch { names = [] }
    if (names.some((name) => name.endsWith(PENDING_SUFFIX) || name.endsWith('.claim'))) return
    try { this.runCommand('/bin/launchctl', ['bootout', `${this.domain}/${AGENT_LABEL}`]) } catch { /* already unloaded */ }
    this.loaded = false
    try { fs.rmSync(this.plistPath, { force: true }) } catch { /* already absent */ }
  }

  private pendingPath(id: string): string {
    return path.join(this.queuePath, `${id}${PENDING_SUFFIX}`)
  }

  private receiptPath(id: string): string {
    return path.join(this.queuePath, `${id}${RECEIPT_SUFFIX}`)
  }

  private cancelledPath(id: string): string {
    return path.join(this.queuePath, `${id}${CANCELLED_SUFFIX}`)
  }
}
