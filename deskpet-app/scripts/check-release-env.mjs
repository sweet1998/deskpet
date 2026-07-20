const required = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
]

const missing = required.filter((name) => !process.env[name]?.trim())
if (missing.length) {
  console.error(`正式发布缺少环境变量：${missing.join(', ')}`)
  console.error('请通过本机环境变量或私密 CI Secret 提供凭据，不要提交到仓库。')
  process.exit(1)
}

console.log('Developer ID 签名与 Apple 公证环境变量检查通过。')
