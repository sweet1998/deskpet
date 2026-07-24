import { describe, expect, it } from 'vitest'
import { chatComposerHeight } from './chat-composer-size'

describe('chatComposerHeight', () => {
  it('keeps an empty composer at one line even when its stale scroll height is large', () => {
    expect(chatComposerHeight('', 180)).toBe(34)
  })

  it('grows with multiline content and clamps to its maximum height', () => {
    expect(chatComposerHeight('两行内容', 58)).toBe(58)
    expect(chatComposerHeight('很多行内容', 180)).toBe(88)
  })
})
