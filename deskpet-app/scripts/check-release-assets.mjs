import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const appDirectory = path.resolve(scriptsDirectory, '..')
const repositoryDirectory = path.resolve(appDirectory, '..')
const requiredFiles = [
  path.join(appDirectory, 'src/renderer/public/live2dcubismcore.min.js'),
  path.join(appDirectory, 'src/renderer/public/models/hiyori_pro_zh/hiyori_pro_zh/runtime/hiyori_pro_t11.model3.json'),
  path.join(appDirectory, 'src/shared/role-profiles.json'),
  path.join(repositoryDirectory, 'LICENSE'),
]

const missing = requiredFiles.filter((filename) => !fs.existsSync(filename))
if (missing.length) {
  console.error('发布资源不完整，已停止构建：')
  for (const filename of missing) console.error(`- ${path.relative(repositoryDirectory, filename)}`)
  console.error('Live2D 模型当前不由 Git 跟踪，请先恢复完整模型目录再生成 DMG。')
  process.exit(1)
}

console.log('发布资源检查通过。')
