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
