import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'

describe('agent store', () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
    setActivePinia(createPinia())
  })

  it('does not open the task panel for conversational execution', () => {
    const store = useAgentStore()
    store.beginRequest('req-1', '分析板块趋势')
    store.applyState({
      requestId: 'req-1',
      state: 'executing',
      progress: 35,
      step: '正在计算趋势',
      interruptible: true,
    })

    expect(store.taskPanelOpen).toBe(false)
    expect(store.progress).toBe(35)
    expect(store.currentStep).toContain('趋势')
  })

  it('keeps an explicitly opened file task panel visible', () => {
    const store = useAgentStore()
    store.beginRequest('req-file', '总结文件', 'report.pdf')
    store.taskPanelOpen = true
    store.applyState({
      requestId: 'req-file',
      state: 'executing',
      progress: 35,
      step: '正在阅读 report.pdf',
      interruptible: true,
    })

    expect(store.taskPanelOpen).toBe(true)
  })

  it('uses one chat open state for the conversation workspace', () => {
    const store = useAgentStore()
    store.chatOpen = true
    expect(store.workspaceOpen).toBe(true)

    store.closeWorkspace()
    expect(store.chatOpen).toBe(false)
  })

  it('records request activity for the inactivity watchdog', () => {
    const store = useAgentStore()
    store.beginRequest('req-active')
    const started = store.activityVersion
    store.touchRequest('req-old')
    expect(store.activityVersion).toBe(started)
    store.touchRequest('req-active')
    expect(store.activityVersion).toBe(started + 1)
  })

  it('deduplicates and removes explicit memories', () => {
    const store = useAgentStore()
    store.addMemory('周五交周报')
    store.addMemory('周五交周报')
    expect(store.memories).toEqual(['周五交周报'])
    store.removeMemory(0)
    expect(store.memories).toEqual([])
  })

  it('clears the user name and long-term memories', () => {
    const store = useAgentStore()
    store.userName = '小林'
    store.addMemory('周五交周报')

    store.clearPersonalData()

    expect(store.userName).toBe('')
    expect(store.memories).toEqual([])
  })

  it('persists the selected role and rejects an invalid persisted role', async () => {
    const store = useAgentStore()
    store.currentRole = 'stock_expert'
    await Promise.resolve()
    expect(JSON.parse(localStorage.getItem('deskpet/agent-preferences') || '{}').currentRole).toBe('stock_expert')

    localStorage.setItem('deskpet/agent-preferences', JSON.stringify({ currentRole: 'admin' }))
    setActivePinia(createPinia())
    expect(useAgentStore().currentRole).toBe('default')
  })

  it('persists the automatic voice reply preference', async () => {
    const store = useAgentStore()
    expect(store.voiceReplyEnabled).toBe(false)
    store.voiceReplyEnabled = true
    await Promise.resolve()
    expect(JSON.parse(localStorage.getItem('deskpet/agent-preferences') || '{}').voiceReplyEnabled).toBe(true)
  })

  it('migrates preferences and memories to encrypted storage', async () => {
    localStorage.setItem('deskpet/agent-preferences', JSON.stringify({ userName: '小林' }))
    localStorage.setItem('deskpet/agent-memories', JSON.stringify(['周五交周报']))
    const writeSecureUserData = vi.fn().mockResolvedValue(true)
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        readSecureUserData: vi.fn().mockResolvedValue({ available: true, exists: false }),
        writeSecureUserData,
      },
    })
    setActivePinia(createPinia())
    const store = useAgentStore()

    await expect(store.hydrateSecureStorage()).resolves.toBe(true)

    expect(store.storageProtected).toBe(true)
    expect(localStorage.getItem('deskpet/agent-preferences')).toBeNull()
    expect(localStorage.getItem('deskpet/agent-memories')).toBeNull()
    expect(writeSecureUserData).toHaveBeenCalledWith('agent', expect.objectContaining({
      preferences: expect.objectContaining({ userName: '小林' }),
      memories: ['周五交周报'],
    }))
  })
})
