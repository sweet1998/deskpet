export interface ConversationContextMessage {
  role: 'user' | 'assistant'
  content: string
}

const NEW_TOPIC_PATTERN = /换(?:个|一个)话题|说点别的|聊点别的|不(?:聊|说)这个了|忽略前面|不用管前面|忘掉前面|重新开始|新话题|另(?:一个|个)问题|另外一个问题/i

export function startsNewConversationTopic(text: string): boolean {
  return NEW_TOPIC_PATTERN.test(text.replace(/\s+/g, ''))
}

export function selectConversationContext(
  history: ConversationContextMessage[],
  currentText: string,
  limit = 20,
): ConversationContextMessage[] {
  if (startsNewConversationTopic(currentText)) return []
  let start = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    if (message.role === 'user' && startsNewConversationTopic(message.content)) {
      start = index
      break
    }
  }
  return history.slice(start).slice(-limit)
}

export function mergeContinuationText(prefix: string, continuation: string, streamed = ''): string {
  const leadingWhitespace = streamed.match(/^\s+/)?.[0] || ''
  if (leadingWhitespace) return `${prefix}${leadingWhitespace}${continuation}`
  const separator = /(?:[。！？.!?：:；;]|\*\*)$/.test(prefix.trimEnd()) ? '\n\n' : ''
  return `${prefix}${separator}${continuation}`
}
