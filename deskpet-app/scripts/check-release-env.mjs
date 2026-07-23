const required = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'LIVE2D_DISTRIBUTION_CONFIRMED',
]

const missing = required.filter((name) => {
  const value = process.env[name]?.trim()
  if (name === 'LIVE2D_DISTRIBUTION_CONFIRMED') return value !== 'true'
  return !value
})
if (missing.length) {
  console.error(`正式发布缺少环境变量：${missing.join(', ')}`)
  console.error('请通过本机环境变量或私密 CI Secret 提供凭据；Live2D 授权确认值必须为 true。')
  process.exit(1)
}

console.log('Developer ID、Apple 公证和 Live2D 分发授权环境检查通过。')
