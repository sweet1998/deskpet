export interface SttTranscriptionResult {
  ok: boolean
  text?: string
  source?: 'macos' | 'bridge'
  error?: string
}

export type SpeechAuthorizationStatus =
  | 'authorized'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unavailable'
  | 'unknown'

export interface VoicePermissionStatus {
  platformSupported: boolean
  helperAvailable: boolean
  microphone: string
  speechRecognition: SpeechAuthorizationStatus
}
