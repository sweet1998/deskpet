import type { AgentFileInput } from '@/services/agent-protocol'

export interface DeskpetTransport {
  sendUserText: (text: string, requestId: string, options?: { clarificationRound?: number }) => boolean
  sendContinuation: (requestId: string) => boolean
  sendFile: (file: AgentFileInput) => boolean
  sendScreenshot: (base64: string, requestId: string) => boolean
  sendInterrupt: (requestId: string) => boolean
  sendConfirmation: (requestId: string, allowed: boolean) => boolean
  sendHeartbeat: () => boolean
  connect: () => void
  disconnect: () => void
}

export interface RawTransportMessage {
  type: string
  data: Record<string, any>
  timestamp?: number
  request_id?: string
}
