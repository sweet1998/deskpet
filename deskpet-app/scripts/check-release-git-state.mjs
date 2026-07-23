import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let status = ''
try {
  status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
} catch (error) {
  console.error(`无法检查 Git 发布状态：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (status) {
  console.error('正式发布必须从干净工作区构建，当前仍有未提交文件：')
  console.error(status)
  process.exit(1)
}

console.log('Git 工作区检查通过。')
