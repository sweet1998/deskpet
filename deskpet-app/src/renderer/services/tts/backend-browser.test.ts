import { describe, expect, it } from 'vitest'
import { normalizeSpeechText } from './backend-browser'

describe('system text to speech', () => {
  it('removes markdown syntax and skips code bodies before speaking', () => {
    expect(normalizeSpeechText([
      '## 结论',
      '- 查看 [详情](https://example.com)',
      '```ts',
      'const secret = 1',
      '```',
    ].join('\n'))).toBe('结论 查看 详情 代码内容已省略。')
  })

  it('limits excessively long responses', () => {
    expect(normalizeSpeechText('答'.repeat(3_000))).toHaveLength(2_000)
  })
})
