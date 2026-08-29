/**
 * electron-builder afterPack hook: ad-hoc sign the macOS bundle.
 *
 * When no Developer ID identity is available, electron-builder skips signing
 * entirely and leaves the prebuilt Electron binary's original signature —
 * which our repacked resources invalidate. A *broken* signature + quarantine
 * makes macOS say "app is damaged" with no right-click escape; a valid
 * ad-hoc signature downgrades that to the standard "unidentified developer"
 * flow.
 *
 * (There is no `identity: null` in electron-builder.yml any more, whatever
 * older comments say — the key is absent entirely, which is what enables
 * auto-discovery. CI now signs and notarizes for real; this fallback is for
 * forks and machines with no certificate. See docs/MACOS-SIGNING.md.)
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // Real signing configured? electron-builder already signed with the actual
  // identity — do not clobber it with an ad-hoc signature.
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_KEY_PASSWORD) {
    console.log('  • real signing identity configured — skipping ad-hoc sign')
    return
  }
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${appName}`)
}
