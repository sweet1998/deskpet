// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { renderSafeMarkdown } from './markdown'

describe('safe markdown rendering', () => {
  it('renders useful answer structure', () => {
    const html = renderSafeMarkdown('| 代码 | 价格 |\n|---|---:|\n| 600519 | 1500 |\n\n```ts\nconst ok = true\n```')
    expect(html).toContain('<table>')
    expect(html).toContain('<pre><code class="hljs">')
    expect(html).toContain('hljs-keyword')
  })

  it('removes scripts, remote images and unsafe links', () => {
    const html = renderSafeMarkdown('<script>alert(1)</script>\n![track](https://tracker.invalid/a.png)\n[本地](file:///tmp/secret)\n[网页](https://example.com)')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('file:///')
    expect(html).toContain('href="https://example.com/"')
    expect(html).toContain('rel="noreferrer noopener"')
  })
})
