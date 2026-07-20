const path = require('node:path')
const { notarize } = require('@electron/notarize')

module.exports = async function notarizeApp(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('未提供 Apple 公证凭据，跳过公证（仅适用于本地未签名测试包）。')
    return
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )
  console.log(`正在公证：${appPath}`)
  await notarize({ appPath, appleId, appleIdPassword, teamId })
}
