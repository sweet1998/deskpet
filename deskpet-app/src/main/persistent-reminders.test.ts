import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MacPersistentReminderScheduler, reminderWorkerSource } from './persistent-reminders'

describe('macOS persistent reminders', () => {
  let directory = ''

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-persistent-reminders-'))
  })

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('writes a private queue and atomically claims in-app delivery', () => {
    const commands: Array<{ command: string; args: string[] }> = []
    const scheduler = new MacPersistentReminderScheduler(
      path.join(directory, 'runtime'),
      path.join(directory, 'LaunchAgents'),
      501,
      (command, args) => {
        commands.push({ command, args })
        return { status: 0 }
      },
    )
    const reminder = {
      id: 'reminder-123',
      title: '麦麦提醒',
      body: '喝水',
      dueAt: Date.now() + 60_000,
      createdAt: Date.now(),
      status: 'scheduled' as const,
    }

    expect(scheduler.schedule(reminder)).toBe(true)
    const plist = fs.readFileSync(
      path.join(directory, 'LaunchAgents', 'com.sweet1998.deskpet.reminders.plist'),
      'utf-8',
    )
    expect(scheduler.tryClaim(reminder.id)).toBe(true)
    scheduler.complete(reminder.id)

    expect(commands.some((item) => item.args[0] === 'bootstrap')).toBe(true)
    expect(fs.existsSync(path.join(directory, 'runtime', 'queue', 'reminder-123.pending.json'))).toBe(false)
    expect(plist).toContain('<key>StartInterval</key>')
    expect(plist).toContain('<integer>10</integer>')
    expect(plist).not.toContain('喝水')
  })

  it('consumes background delivery receipts exactly once', () => {
    const root = path.join(directory, 'runtime')
    const queue = path.join(root, 'queue')
    fs.mkdirSync(queue, { recursive: true })
    fs.writeFileSync(path.join(queue, 'reminder-456.delivered.json'), JSON.stringify({
      id: 'reminder-456',
      deliveredAt: Date.now(),
    }))
    const scheduler = new MacPersistentReminderScheduler(
      root,
      path.join(directory, 'LaunchAgents'),
      501,
      () => ({ status: 0 }),
    )

    expect([...scheduler.consumeDelivered()]).toEqual(['reminder-456'])
    expect([...scheduler.consumeDelivered()]).toEqual([])
  })

  it.runIf(process.platform === 'darwin')('ships a JXA worker that macOS can execute', () => {
    const scriptPath = path.join(directory, 'worker.js')
    const queuePath = path.join(directory, 'queue')
    fs.mkdirSync(queuePath)
    fs.writeFileSync(scriptPath, reminderWorkerSource())
    fs.writeFileSync(path.join(queuePath, 'cancelled-test.pending.json'), JSON.stringify({
      id: 'cancelled-test',
      title: '不会显示',
      body: '该提醒已取消',
      dueAt: Date.now() - 1_000,
      createdAt: Date.now() - 2_000,
      status: 'scheduled',
    }))
    fs.writeFileSync(path.join(queuePath, 'cancelled-test.cancelled'), '1')

    const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', scriptPath, queuePath], {
      encoding: 'utf-8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(fs.readdirSync(queuePath)).toEqual([])
  })
})
