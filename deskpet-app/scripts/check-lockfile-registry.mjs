import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = path.join(root, 'package-lock.json')
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
const invalid = Object.entries(lock.packages || {})
  .map(([name, value]) => ({ name: name || '<root>', resolved: value?.resolved }))
  .filter(({ resolved }) => (
    typeof resolved === 'string'
    && /^https?:\/\//i.test(resolved)
    && !resolved.startsWith('https://registry.npmjs.org/')
  ))

if (invalid.length) {
  console.error('package-lock.json 包含非官方依赖下载地址：')
  for (const item of invalid) console.error(`- ${item.name}: ${item.resolved}`)
  process.exit(1)
}

console.log('依赖锁文件只使用官方 npm registry。')
