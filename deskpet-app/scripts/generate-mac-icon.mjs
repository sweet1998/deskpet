import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const appDirectory = path.resolve(scriptsDirectory, '..')
const source = path.join(appDirectory, 'src', 'renderer', 'public', 'icon.svg')
const outputDirectory = path.join(appDirectory, 'build')
const output = path.join(outputDirectory, 'icon.png')
const temporarySvg = path.join(os.tmpdir(), `deskpet-icon-${process.pid}.svg`)

const svg = fs.readFileSync(source, 'utf8')
const squareSvg = svg.replace(
  'viewBox="0 0 117.4 142.1"',
  'viewBox="-12.35 0 142.1 142.1"',
)
if (squareSvg === svg) throw new Error('无法识别图标 SVG 的 viewBox')

fs.mkdirSync(outputDirectory, { recursive: true })
fs.writeFileSync(temporarySvg, squareSvg)
try {
  execFileSync('sips', [
    '-s', 'format', 'png',
    '--resampleHeightWidth', '1024', '1024',
    temporarySvg,
    '--out', output,
  ], { stdio: 'inherit' })
} finally {
  fs.rmSync(temporarySvg, { force: true })
}

console.log(`已生成 macOS 图标：${output}`)
