import DOMPurify from 'dompurify'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr',
]

function isEscaped(source: string, index: number): boolean {
  let slashes = 0
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1
  return slashes % 2 === 1
}

function isAsciiOperand(value: string): boolean {
  return /[A-Za-z0-9_]/.test(value)
}

export function streamingDisplayText(value: string): string {
  const source = typeof value === 'string' ? value.slice(0, 200_000) : ''
  let output = ''
  let fenced = false
  let inlineTicks = 0

  for (let index = 0; index < source.length;) {
    if (source[index] === '`') {
      let end = index + 1
      while (source[end] === '`') end += 1
      const ticks = end - index
      output += source.slice(index, end)
      if (ticks >= 3 && inlineTicks === 0) fenced = !fenced
      else if (!fenced) {
        if (inlineTicks === ticks) inlineTicks = 0
        else if (inlineTicks === 0) inlineTicks = ticks
      }
      index = end
      continue
    }

    if (source[index] === '*' && !fenced && inlineTicks === 0 && !isEscaped(source, index)) {
      let end = index + 1
      while (source[end] === '*') end += 1
      const runLength = end - index
      const previous = source[index - 1] || ''
      const next = source[end] || ''
      if (runLength >= 2 || !isAsciiOperand(previous) || !isAsciiOperand(next)) {
        index = end
        continue
      }
    }

    output += source[index]
    index += 1
  }
  return output
}

export function renderSafeMarkdown(value: string): string {
  const source = typeof value === 'string' ? value.slice(0, 200_000) : ''
  const rendered = String(marked.parse(source, { async: false, gfm: true, breaks: true }))
  const sanitized = DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'class'],
    ALLOW_DATA_ATTR: false,
  })
  const template = document.createElement('template')
  template.innerHTML = sanitized
  const codeLanguages = new Map<Element, string>()
  for (const code of template.content.querySelectorAll('pre code')) {
    const languageClass = [...code.classList].find((name) => name.startsWith('language-'))
    if (languageClass) codeLanguages.set(code, languageClass.slice('language-'.length).toLowerCase())
  }
  for (const element of template.content.querySelectorAll('[class]')) element.removeAttribute('class')
  for (const [code, language] of codeLanguages) {
    if (!hljs.getLanguage(language)) continue
    code.innerHTML = hljs.highlight(code.textContent || '', { language }).value
    code.classList.add('hljs')
  }
  for (const anchor of template.content.querySelectorAll('a')) {
    try {
      const url = new URL(anchor.getAttribute('href') || '')
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
      anchor.setAttribute('href', url.toString())
      anchor.setAttribute('rel', 'noreferrer noopener')
    } catch {
      anchor.replaceWith(document.createTextNode(anchor.textContent || ''))
    }
  }
  return template.innerHTML
}
