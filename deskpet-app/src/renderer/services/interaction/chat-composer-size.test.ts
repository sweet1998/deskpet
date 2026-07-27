import { describe, expect, it } from 'vitest'
import { chatComposerHeight } from './chat-composer-size'

describe('chatComposerHeight', () => {
  it('keeps an empty composer at one line even when its stale scroll height is large', () => {
    expect(chatComposerHeight('', 180)).toBe(34)
  })

  it('keeps content that visually fits on one line at the minimum height', () => {
    expect(chatComposerHeight('今天行情怎么样', 180, true)).toBe(34)
  })

  it('grows for wrapped or explicit multiline content', () => {
    expect(chatComposerHeight('这是一段会自动换行的较长内容', 54)).toBe(54)
    expect(chatComposerHeight('第一行\n第二行', 54)).toBe(54)
  })

  it('clamps long content to three visible lines', () => {
    expect(chatComposerHeight('第一行\n第二行\n第三行\n第四行', 180)).toBe(72)
  })
})
