import { app, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import { recognizeWithMacosVision } from './macos-ocr'

interface SmokeResult {
  ok: boolean
  checks: Record<string, boolean | number | string>
  phase?: string
  error?: string
}

function writeProgress(
  outputPath: string,
  checks: SmokeResult['checks'],
  phase: string,
): void {
  fs.writeFileSync(outputPath, JSON.stringify({ ok: false, phase, checks }, null, 2), { mode: 0o600 })
}

async function waitFor(
  window: BrowserWindow,
  expression: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (window.isDestroyed()) return false
    const matched = await window.webContents.executeJavaScript(`Boolean(${expression})`, true)
    if (matched) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function visiblePixels(window: BrowserWindow): Promise<{
  count: number
  point: { x: number; y: number } | null
}> {
  const image = await window.capturePage()
  const bitmap = image.toBitmap()
  const size = image.getSize()
  let visible = 0
  let sumX = 0
  let sumY = 0
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] <= 8) continue
    const pixelIndex = (index - 3) / 4
    visible += 1
    sumX += pixelIndex % size.width
    sumY += Math.floor(pixelIndex / size.width)
  }
  if (!visible) return { count: 0, point: null }

  const centerX = sumX / visible
  const centerY = sumY / visible
  let selected: { x: number; y: number; distance: number } | null = null
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] <= 32) continue
    const pixelIndex = (index - 3) / 4
    const x = pixelIndex % size.width
    const y = Math.floor(pixelIndex / size.width)
    const distance = (x - centerX) ** 2 + (y - centerY) ** 2
    if (!selected || distance < selected.distance) selected = { x, y, distance }
  }
  const bounds = window.getContentBounds()
  return {
    count: visible,
    point: selected ? {
      x: Math.max(0, Math.min(bounds.width - 1, Math.round(selected.x * bounds.width / size.width))),
      y: Math.max(0, Math.min(bounds.height - 1, Math.round(selected.y * bounds.height / size.height))),
    } : null,
  }
}

export async function runElectronSmoke(
  window: BrowserWindow,
  outputPath: string,
): Promise<SmokeResult> {
  const checks: SmokeResult['checks'] = {}
  try {
    writeProgress(outputPath, checks, 'waiting-for-stage')
    checks.stage = await waitFor(window, "document.querySelector('.deskpet-stage')")
    writeProgress(outputPath, checks, 'waiting-for-onboarding')
    checks.onboarding = await waitFor(window, "document.querySelector('.settings-panel')")
    writeProgress(outputPath, checks, 'waiting-for-live2d')
    checks.modelLoaded = await waitFor(
      window,
      "document.querySelector('.live2d-stage canvas') && !document.querySelector('.model-error')",
      20_000,
    )
    writeProgress(outputPath, checks, 'checking-settings')
    const settingsSize = await window.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('.settings-panel')
      if (!node) return { width: 0, height: 0 }
      const rect = node.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })()`, true) as { width: number; height: number }
    checks.settingsWidth = settingsSize.width
    checks.settingsHeight = settingsSize.height
    checks.settingsReadable = settingsSize.width >= 300 && settingsSize.height >= 500

    writeProgress(outputPath, checks, 'checking-native-ocr')
    await new Promise((resolve) => setTimeout(resolve, 500))
    let ocr: Awaited<ReturnType<typeof recognizeWithMacosVision>> = { ok: false, error: 'OCR 尚未执行' }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const settingsScreenshot = await window.capturePage()
      ocr = await recognizeWithMacosVision(settingsScreenshot.toPNG(), 'png', {
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        tempPath: app.getPath('temp'),
        isPackaged: app.isPackaged,
      })
      if (ocr.ok && ocr.text && ocr.text.length >= 8) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    checks.ocrRecognized = ocr.ok === true && Boolean(ocr.text && ocr.text.length >= 8)
    if (!checks.ocrRecognized) checks.ocrStatus = ocr.error || '没有识别到足够的设置文本'

    writeProgress(outputPath, checks, 'configuring-ai')
    checks.onboardingSubmitted = await window.webContents.executeJavaScript(`(async () => {
      const panel = document.querySelector('.settings-panel')
      const key = panel?.querySelector('input[type="password"]')
      const model = panel?.querySelector('.provider-section input:not([type="password"]):not([type="checkbox"])')
      const consent = panel?.querySelector('.legal-consent input[type="checkbox"]')
      if (!(key instanceof HTMLInputElement) || !(model instanceof HTMLInputElement) || !(consent instanceof HTMLInputElement)) return false
      key.value = 'e2e-api-key'
      key.dispatchEvent(new Event('input', { bubbles: true }))
      model.value = 'e2e-endpoint'
      model.dispatchEvent(new Event('input', { bubbles: true }))
      if (!consent.checked) consent.click()
      await new Promise(resolve => setTimeout(resolve, 50))
      const submit = [...panel.querySelectorAll('button')].find(button => button.textContent?.includes('验证并完成'))
      if (!(submit instanceof HTMLButtonElement) || submit.disabled) return false
      submit.click()
      return true
    })()`, true) as boolean
    checks.settingsClosed = await waitFor(window, "!document.querySelector('.settings-panel')", 15_000)
    if (!checks.settingsClosed) {
      checks.settingsStatus = await window.webContents.executeJavaScript(
        "document.querySelector('.provider-section .status')?.textContent?.trim() || '设置面板未关闭且没有状态提示'",
        true,
      ) as string
    }
    writeProgress(outputPath, checks, 'checking-native-ipc')
    const nativeChecks = await window.webContents.executeJavaScript(`(async () => {
      const api = window.electronAPI
      if (!api) return {}
      const text = 'deskpet native attachment e2e'
      const file = await api.extractNativeFile({
        name: 'e2e.txt',
        size: text.length,
        base64: btoa(text),
      })
      const reminder = await api.createNativeReminder({
        title: 'E2E reminder',
        body: 'isolated reminder',
        dueAt: Date.now() + 60_000,
      })
      const reminderCreated = Boolean(reminder && !('error' in reminder))
      const listed = reminderCreated ? await api.listNativeReminders() : []
      const reminderListed = reminderCreated && listed.some(item => item.id === reminder.id)
      const reminderCancelled = reminderCreated ? await api.cancelNativeReminder(reminder.id) : false
      const invalidUrlRejected = await api.openNativeUrl('javascript:alert(1)') === false
      const voice = await api.getVoicePermissionStatus()
      return {
        attachmentExtracted: file.ok === true && file.text === text,
        reminderCreated,
        reminderListed,
        reminderCancelled,
        invalidUrlRejected,
        voiceHelperAvailable: voice?.platformSupported === true && voice?.helperAvailable === true,
      }
    })()`, true) as Record<string, boolean>
    Object.assign(checks, nativeChecks)
    await new Promise((resolve) => setTimeout(resolve, 600))
    writeProgress(outputPath, checks, 'capturing-pet')
    writeProgress(outputPath, checks, 'opening-chat')
    checks.chatOpened = false
    for (let attempt = 0; attempt < 3 && !checks.chatOpened; attempt += 1) {
      const petPixels = await visiblePixels(window)
      checks.petVisiblePixels = Math.max(Number(checks.petVisiblePixels || 0), petPixels.count)
      if (petPixels.point) {
        window.webContents.sendInputEvent({
          type: 'mouseDown', x: petPixels.point.x, y: petPixels.point.y, button: 'left', clickCount: 1,
        })
        window.webContents.sendInputEvent({
          type: 'mouseUp', x: petPixels.point.x, y: petPixels.point.y, button: 'left', clickCount: 1,
        })
      }
      checks.chatOpened = await waitFor(window, "document.querySelector('.interaction-controls')", 2_500)
      if (!checks.chatOpened) await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!checks.chatOpened) throw new Error('连续三次单击人物后仍未打开对话')

    writeProgress(outputPath, checks, 'requesting-streaming-answer')
    checks.chatRequestSubmitted = await window.webContents.executeJavaScript(`(async () => {
      const input = document.querySelector('.input-row textarea')
      if (!(input instanceof HTMLTextAreaElement)) return false
      input.value = '请回复端到端流式测试'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 50))
      const send = document.querySelector('button[title="发送"]')
      if (!(send instanceof HTMLButtonElement) || send.disabled) return false
      send.click()
      return true
    })()`, true) as boolean
    checks.streamStarted = await waitFor(
      window,
      "[...document.querySelectorAll('.message.assistant .message-text')].some(node => node.textContent?.includes('这是'))",
      10_000,
    )
    checks.streamCompleted = await waitFor(
      window,
      "[...document.querySelectorAll('.message.assistant:not(.streaming)')].some(node => node.textContent?.includes('这是一段端到端流式回答'))",
      10_000,
    )

    writeProgress(outputPath, checks, 'checking-attachment-regeneration')
    checks.attachmentRequestSubmitted = await window.webContents.executeJavaScript(`(async () => {
      const input = document.querySelector('.file-input')
      const composer = document.querySelector('.input-row textarea')
      if (!(input instanceof HTMLInputElement) || !(composer instanceof HTMLTextAreaElement)) return false
      const transfer = new DataTransfer()
      transfer.items.add(new File(['deskpet attachment replay'], 'e2e.txt', { type: 'text/plain' }))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      composer.value = '请总结这个附件'
      composer.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 50))
      const send = document.querySelector('button[title="发送"]')
      if (!(send instanceof HTMLButtonElement) || send.disabled) return false
      send.click()
      return true
    })()`, true) as boolean
    checks.attachmentAnswered = await waitFor(
      window,
      "[...document.querySelectorAll('.message.assistant')].some(node => node.textContent?.includes('附件首次回答'))",
      10_000,
    )
    checks.attachmentRetryClicked = await window.webContents.executeJavaScript(`(() => {
      const answer = [...document.querySelectorAll('.message.assistant')]
        .find(node => node.textContent?.includes('附件首次回答'))
      const retry = answer?.querySelector('button[title="重新生成"]')
      if (!(retry instanceof HTMLButtonElement) || retry.disabled) return false
      window.__deskpetE2eUserCount = document.querySelectorAll('.message.user').length
      retry.click()
      return true
    })()`, true) as boolean
    checks.attachmentRegenerated = await waitFor(
      window,
      "[...document.querySelectorAll('.message.assistant')].some(node => node.textContent?.includes('附件重新生成回答'))",
      10_000,
    )
    checks.attachmentRetryKeptSingleUserMessage = await window.webContents.executeJavaScript(
      "document.querySelectorAll('.message.user').length === window.__deskpetE2eUserCount",
      true,
    ) as boolean

    writeProgress(outputPath, checks, 'checking-friendly-model-error')
    checks.errorRequestSubmitted = await window.webContents.executeJavaScript(`(async () => {
      const input = document.querySelector('.input-row textarea')
      if (!(input instanceof HTMLTextAreaElement)) return false
      input.value = '[E2E_ERROR]'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 50))
      const send = document.querySelector('button[title="发送"]')
      if (!(send instanceof HTMLButtonElement) || send.disabled) return false
      send.click()
      return true
    })()`, true) as boolean
    checks.friendlyErrorShown = await waitFor(
      window,
      "[...document.querySelectorAll('.message.status')].some(node => node.textContent?.includes('豆包服务暂时不可用'))",
      10_000,
    )

    await window.webContents.executeJavaScript(
      "document.querySelector('button[title=\"收起对话\"]')?.click()",
      true,
    )
    writeProgress(outputPath, checks, 'checking-chat-close-frames')
    const frameSamples: number[] = []
    for (let index = 0; index < 5; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      frameSamples.push((await visiblePixels(window)).count)
    }
    checks.chatClosed = await waitFor(window, "!document.querySelector('.interaction-controls')")
    checks.closeFramesNonblank = frameSamples.every((count) => count > 100)
    checks.minimumCloseFramePixels = Math.min(...frameSamples)
    writeProgress(outputPath, checks, 'finalizing')

    const ok = Boolean(
      checks.stage
      && checks.onboarding
      && checks.modelLoaded
      && checks.settingsReadable
      && checks.ocrRecognized
      && checks.onboardingSubmitted
      && checks.settingsClosed
      && checks.attachmentExtracted
      && checks.reminderCreated
      && checks.reminderListed
      && checks.reminderCancelled
      && checks.invalidUrlRejected
      && checks.voiceHelperAvailable
      && Number(checks.petVisiblePixels) > 100
      && checks.chatOpened
      && checks.chatRequestSubmitted
      && checks.streamStarted
      && checks.streamCompleted
      && checks.attachmentRequestSubmitted
      && checks.attachmentAnswered
      && checks.attachmentRetryClicked
      && checks.attachmentRegenerated
      && checks.attachmentRetryKeptSingleUserMessage
      && checks.errorRequestSubmitted
      && checks.friendlyErrorShown
      && checks.chatClosed
      && checks.closeFramesNonblank
    )
    const result = { ok, checks }
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 })
    return result
  } catch (error) {
    const result: SmokeResult = {
      ok: false,
      checks,
      error: error instanceof Error ? error.stack || error.message : String(error),
    }
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 })
    return result
  }
}
