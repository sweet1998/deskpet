import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttachmentWorkflow } from './useAttachmentWorkflow'

function createHarness(sendUserText = vi.fn(() => true)) {
  const agent = {
    interruptible: false,
    confirmation: null,
    currentRole: 'default',
    chatOpen: false,
    taskPanelOpen: false,
    beginRequest: vi.fn(),
    applyState: vi.fn(),
  }
  const chat = {
    addUserMessage: vi.fn(),
    showStatusMessage: vi.fn(),
    resetRequestResponse: vi.fn(),
  }
  const options = {
    agent: agent as any,
    chat: chat as any,
    transport: { sendUserText },
    requireLegalConsent: vi.fn(() => true),
    cancelSpeech: vi.fn(),
    createRequestId: vi.fn(() => 'request-1'),
    startRequestTimer: vi.fn(),
    clearRequestTimer: vi.fn(),
  }
  return { agent, chat, options, workflow: useAttachmentWorkflow(options as any), sendUserText }
}

describe('useAttachmentWorkflow', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        extractNativeFile: vi.fn(async () => ({ ok: true, text: '附件正文', truncated: false })),
        appendNativeToolAudit: vi.fn(async () => undefined),
      },
    })
  })

  it('extracts files locally and submits the generated prompt', async () => {
    const harness = createHarness()
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain', lastModified: 1 })

    await harness.workflow.submitUserFiles('总结重点', [file])

    expect(window.electronAPI?.extractNativeFile).toHaveBeenCalledWith(expect.objectContaining({
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
    }))
    expect(harness.chat.addUserMessage).toHaveBeenCalledWith(
      '总结重点',
      'request-1',
      'default',
      [expect.objectContaining({ name: 'notes.txt', size: 5 })],
      undefined,
      'file',
    )
    expect(harness.sendUserText).toHaveBeenCalledWith(
      expect.stringContaining('<attachment name="notes.txt">\n附件正文\n</attachment>'),
      'request-1',
    )
    expect(harness.options.startRequestTimer).toHaveBeenCalledWith('request-1')
  })

  it('reports extraction failures without sending a model request', async () => {
    vi.mocked(window.electronAPI!.extractNativeFile).mockResolvedValueOnce({
      ok: false,
      name: 'broken.pdf',
      text: '',
      truncated: false,
      error: '文件无法读取',
    })
    const harness = createHarness()

    await harness.workflow.submitUserFiles('', [new File(['x'], 'broken.pdf')])

    expect(harness.sendUserText).not.toHaveBeenCalled()
    expect(harness.chat.showStatusMessage).toHaveBeenCalledWith(
      'request-1',
      '文件无法读取',
      'service',
      false,
    )
    expect(harness.agent.applyState).toHaveBeenLastCalledWith(expect.objectContaining({
      state: 'error',
      error: '文件无法读取',
    }))
  })

  it('replays the extracted prompt without retaining the original File', async () => {
    const harness = createHarness()
    await harness.workflow.submitUserFiles('分析', [new File(['x'], 'data.txt')])
    vi.mocked(window.electronAPI!.extractNativeFile).mockClear()
    harness.sendUserText.mockClear()

    harness.workflow.retryFileRequest('request-1')

    expect(window.electronAPI?.extractNativeFile).not.toHaveBeenCalled()
    expect(harness.chat.resetRequestResponse).toHaveBeenCalledWith('request-1')
    expect(harness.sendUserText).toHaveBeenCalledWith(expect.stringContaining('附件正文'), 'request-1')
  })
})
