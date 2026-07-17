import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentStore } from './agent'

describe('agent store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('tracks a task lifecycle and opens the task panel', () => {
    const store = useAgentStore()
    store.beginRequest('req-1', '总结文件', 'report.pdf')
    store.applyState({
      requestId: 'req-1',
      state: 'executing',
      progress: 35,
      step: '正在阅读 report.pdf',
      interruptible: true,
    })

    expect(store.taskPanelOpen).toBe(true)
    expect(store.progress).toBe(35)
    expect(store.currentStep).toContain('report.pdf')
  })

  it('deduplicates and removes explicit memories', () => {
    const store = useAgentStore()
    store.addMemory('周五交周报')
    store.addMemory('周五交周报')
    expect(store.memories).toEqual(['周五交周报'])
    store.removeMemory(0)
    expect(store.memories).toEqual([])
  })
})

