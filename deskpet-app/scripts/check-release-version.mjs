import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(appDirectory, 'package.json'), 'utf8'))
const expectedTag = `v${packageJson.version}`

let releaseTag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || ''
if (!releaseTag) {
  try {
    releaseTag = execFileSync('git', ['describe', '--tags', '--exact-match'], {
      cwd: appDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    releaseTag = ''
  }
}

if (releaseTag !== expectedTag) {
  console.error(`版本不一致：package.json=${packageJson.version}，发布标签=${releaseTag || '未提供'}。`)
  console.error(`正式发布必须从标签 ${expectedTag} 构建。`)
  process.exit(1)
}

try {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: appDirectory,
    encoding: 'utf8',
  }).trim()
  const tagCommit = execFileSync('git', ['rev-list', '-n', '1', expectedTag], {
    cwd: appDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!tagCommit || tagCommit !== head) {
    console.error(`发布标签 ${expectedTag} 未指向当前提交。`)
    process.exit(1)
  }
} catch {
  console.error(`无法验证发布标签 ${expectedTag}，请先创建并检出该标签。`)
  process.exit(1)
}

console.log(`发布版本检查通过：${expectedTag}`)
