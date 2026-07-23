import type { TTSBackend } from './types'

function isAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function normalizeSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' 代码内容已省略。 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000)
}

export function createBrowserTtsBackend(): TTSBackend {
  return {
    speak(text: string) {
      if (!isAvailable()) return Promise.resolve(false)
      const normalized = normalizeSpeechText(text)
      if (!normalized) return Promise.resolve(false)
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(normalized)
      const voice = window.speechSynthesis.getVoices().find((item) => (
        item.lang.toLocaleLowerCase().startsWith('zh')
      ))
      utterance.lang = voice?.lang || 'zh-CN'
      if (voice) utterance.voice = voice
      utterance.rate = 1.0
      utterance.pitch = 1.1
      return new Promise((resolve) => {
        utterance.onend = () => resolve(true)
        utterance.onerror = () => resolve(false)
        window.speechSynthesis.speak(utterance)
      })
    },
    cancel() {
      if (isAvailable()) window.speechSynthesis.cancel()
    },
    getAudioElement() { return null },
  }
}
