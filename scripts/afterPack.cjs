/**
 * electron-builder afterPack hook: ad-hoc sign the macOS bundle.
 *
 * With identity:null electron-builder skips signing entirely, leaving the
 * prebuilt Electron binary's original signature — which our repacked
 * resources invalidate. A *broken* signature + quarantine makes macOS say
 * "app is damaged" with no right-click escape; a valid ad-hoc signature
 * downgrades that to the standard "unidentified developer" flow.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${appName}`)
}
