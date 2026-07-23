import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const AUTHORING_EXTENSIONS = new Set(['.can3', '.cmo3', '.clip', '.kra', '.psd'])

export async function pruneRendererAuthoringAssets(root) {
  let removedFiles = 0
  let removedBytes = 0

  async function visit(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }

    await Promise.all(entries.map(async (entry) => {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(target)
        return
      }
      if (!AUTHORING_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return
      const info = await stat(target)
      await rm(target, { force: true })
      removedFiles += 1
      removedBytes += info.size
    }))
  }

  await visit(root)
  return { removedFiles, removedBytes }
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const root = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(path.dirname(scriptPath), '..', 'out', 'renderer', 'models')
  const result = await pruneRendererAuthoringAssets(root)
  const removedMB = (result.removedBytes / 1024 / 1024).toFixed(1)
  console.log(`已从渲染器产物移除 ${result.removedFiles} 个模型编辑文件（${removedMB} MB）。`)
}
