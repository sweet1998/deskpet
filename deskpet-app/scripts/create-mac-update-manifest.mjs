import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function digest(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64')
}

export function createMacUpdateManifest(directory, version, releaseDate = new Date().toISOString()) {
  const names = fs.readdirSync(directory)
    .filter((name) => name.startsWith(`MaiMai-DeskPet-${version}-`) && /\.(?:zip|dmg)$/.test(name))
    .sort((left, right) => {
      const leftRank = left.endsWith('-arm64.zip') ? 0 : left.endsWith('-x64.zip') ? 1 : left.endsWith('.zip') ? 2 : 3
      const rightRank = right.endsWith('-arm64.zip') ? 0 : right.endsWith('-x64.zip') ? 1 : right.endsWith('.zip') ? 2 : 3
      return leftRank - rightRank || left.localeCompare(right)
    })
  const zips = names.filter((name) => name.endsWith('.zip'))
  if (!names.length || !zips.length) throw new Error('没有找到可写入更新清单的 macOS ZIP/DMG')
  const fallback = zips.find((name) => name.includes('-arm64.')) || zips[0]
  const entries = names.map((name) => {
    const filePath = path.join(directory, name)
    return { name, sha512: digest(filePath), size: fs.statSync(filePath).size }
  })
  const fallbackEntry = entries.find((entry) => entry.name === fallback)
  const lines = [
    `version: ${version}`,
    'files:',
    ...entries.flatMap((entry) => [
      `  - url: ${entry.name}`,
      `    sha512: ${entry.sha512}`,
      `    size: ${entry.size}`,
    ]),
    `path: ${fallback}`,
    `sha512: ${fallbackEntry.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ]
  const manifestPath = path.join(directory, 'latest-mac.yml')
  fs.writeFileSync(manifestPath, lines.join('\n'))
  return manifestPath
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = path.resolve(process.argv[2] || 'dist')
  const version = process.argv[3]
  if (!version) throw new Error('用法：node create-mac-update-manifest.mjs <目录> <版本>')
  process.stdout.write(`${createMacUpdateManifest(directory, version)}\n`)
}
