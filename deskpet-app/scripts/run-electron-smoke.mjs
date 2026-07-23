import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import electronPath from 'electron'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-electron-smoke-'))
const output = path.join(root, 'result.json')
const userData = path.join(root, 'user-data')
const packagedExecutable = process.env.DESKPET_E2E_EXECUTABLE?.trim()
const modelRequests = []
const modelServer = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  let raw = ''
  for await (const chunk of request) raw += chunk
  let body
  try { body = JSON.parse(raw) } catch { body = {} }
  modelRequests.push({ authorization: request.headers.authorization, body })
  const serializedMessages = JSON.stringify(body.messages || [])
  if (JSON.stringify(body.messages || []).includes('[E2E_ERROR]')) {
    response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: { message: 'simulated outage' } }))
    return
  }
  if (body.stream) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const attachmentAttempt = serializedMessages.includes('deskpet attachment replay')
      ? modelRequests.filter(({ body: candidate }) => (
          JSON.stringify(candidate?.messages || []).includes('deskpet attachment replay')
        )).length
      : 0
    const parts = body.max_tokens === 16
      ? ['流式', '正常']
      : attachmentAttempt > 1
        ? ['附件重新生成', '回答']
        : attachmentAttempt === 1
          ? ['附件首次', '回答']
          : ['这是', '一段端到端', '流式回答']
    parts.forEach((part, index) => {
      setTimeout(() => {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
        if (index === parts.length - 1) response.end('data: [DONE]\n\n')
      }, index * 350)
    })
    return
  }
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ choices: [{ message: { content: '连接成功' } }] }))
})
await new Promise((resolve, reject) => {
  modelServer.once('error', reject)
  modelServer.listen(0, '127.0.0.1', resolve)
})
const modelAddress = modelServer.address()
if (!modelAddress || typeof modelAddress === 'string') throw new Error('无法启动 E2E 模型服务')
const child = spawn(packagedExecutable || electronPath, packagedExecutable ? [] : ['.'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    DESKPET_E2E_OUTPUT: output,
    DESKPET_E2E_USER_DATA: userData,
    DESKPET_E2E_MODEL_URL: `http://127.0.0.1:${modelAddress.port}/v1`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let logs = ''
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-20_000) })
}

let timedOut = false
let forceKill
const timeout = setTimeout(() => {
  timedOut = true
  child.kill('SIGTERM')
  forceKill = setTimeout(() => child.kill('SIGKILL'), 5_000)
}, 90_000)
const exitCode = await new Promise((resolve) => child.once('exit', resolve))
clearTimeout(timeout)
if (forceKill) clearTimeout(forceKill)

try {
  if (!fs.existsSync(output)) throw new Error(`Electron 未生成测试结果。\n${logs}`)
  const result = JSON.parse(fs.readFileSync(output, 'utf-8'))
  if (timedOut) throw new Error(`Electron 冒烟测试超时：\n${JSON.stringify(result, null, 2)}\n${logs}`)
  if (!result.ok) {
    throw new Error(`Electron 冒烟测试失败：\n${JSON.stringify(result, null, 2)}\n模型请求：${JSON.stringify(modelRequests)}\n${logs}`)
  }
  const chatRequest = modelRequests.find(({ authorization, body }) => (
    authorization === 'Bearer e2e-api-key'
    && body?.stream === true
    && body?.max_tokens === 1200
  ))
  if (!chatRequest || modelRequests.length < 4) {
    throw new Error(`Electron 未完成预期的能力检测和流式模型请求：${JSON.stringify(modelRequests)}`)
  }
  console.log(JSON.stringify(result, null, 2))
  if (exitCode !== 0) throw new Error(`Electron 异常退出：${exitCode}`)
} finally {
  await new Promise((resolve) => modelServer.close(resolve))
  fs.rmSync(root, { recursive: true, force: true })
}
