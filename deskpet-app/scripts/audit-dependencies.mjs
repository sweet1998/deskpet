import { spawnSync } from 'node:child_process'

const acceptedAdvisories = new Map([
  ['https://github.com/advisories/GHSA-mh99-v99m-4gvg', {
    reviewAfter: '2026-10-31',
    reason: '上游旧版 minimatch 尚无兼容补丁；桌宠不会把用户输入作为 glob 或 brace 表达式执行。',
  }],
])

function directSources(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return new Set()
  const vulnerability = vulnerabilities[name]
  if (!vulnerability) return new Set([`unknown-dependency:${name}`])
  const nextSeen = new Set(seen).add(name)
  const sources = new Set()
  for (const via of vulnerability.via || []) {
    if (typeof via === 'string') {
      for (const source of directSources(via, vulnerabilities, nextSeen)) sources.add(source)
    } else if (via && typeof via.url === 'string') {
      sources.add(via.url)
    } else {
      sources.add(`unknown-advisory:${name}`)
    }
  }
  if (!(vulnerability.via || []).length) sources.add(`missing-advisory:${name}`)
  return sources
}

function activeAcceptedAdvisories() {
  const today = new Date().toISOString().slice(0, 10)
  return new Map([...acceptedAdvisories].filter(([, value]) => today <= value.reviewAfter))
}

const audit = spawnSync('npm', [
  'audit',
  '--json',
  '--package-lock-only',
  '--registry=https://registry.npmjs.org',
], {
  cwd: new URL('..', import.meta.url),
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
})

let report
try {
  report = JSON.parse(audit.stdout)
} catch {
  console.error('无法解析 npm audit 输出，安全审计已停止。')
  if (audit.stderr) console.error(audit.stderr.trim())
  process.exit(1)
}

if (report.error) {
  console.error(`npm audit 请求失败：${report.error.summary || report.error.code || '未知错误'}`)
  process.exit(1)
}

const vulnerabilities = report.vulnerabilities || {}
const accepted = activeAcceptedAdvisories()
const rejected = []
const acceptedPackages = []

for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  const resolvedSources = [...directSources(name, vulnerabilities)]
  const sources = resolvedSources.length ? resolvedSources : [`unresolved-cycle:${name}`]
  const unaccepted = sources.filter((source) => !accepted.has(source))
  if (unaccepted.length) {
    rejected.push({ name, severity: vulnerability.severity, sources: unaccepted })
  } else {
    acceptedPackages.push(name)
  }
}

if (rejected.length) {
  console.error('发现未被安全策略接受的依赖公告：')
  for (const item of rejected) {
    console.error(`- ${item.name} (${item.severity}): ${item.sources.join(', ')}`)
  }
  process.exit(1)
}

if (acceptedPackages.length) {
  const source = [...accepted.keys()][0]
  const exception = accepted.get(source)
  console.warn(`已接受 ${acceptedPackages.length} 个由 ${source} 传播的依赖告警。`)
  console.warn(`原因：${exception.reason}`)
  console.warn(`最晚复查日期：${exception.reviewAfter}`)
}

console.log('依赖安全审计通过，未发现未接受的公告。')
