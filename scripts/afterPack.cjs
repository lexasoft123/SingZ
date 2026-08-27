/**
 * electron-builder afterPack hook: verify the copied native capture artifact,
 * then ad-hoc sign final macOS bundles.
 *
 * With identity:null electron-builder leaves the repacked app unsigned. A
 * broken/stale bundle signature + quarantine makes macOS say "app is damaged"
 * with no right-click escape; a valid ad-hoc signature downgrades that to the
 * standard "unidentified developer" flow. Deep signing also rewrites the
 * nested capture Mach-O's signature bytes, so packaged verification validates
 * that signature instead of pretending its pre-sign raw SHA still matches.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { Arch } = require('builder-util')
const { verifyCaptureSnapshot } = require('./capture-artifact.cjs')
const { sourceFingerprint } = require('./build-capture-addon.cjs')

const root = path.resolve(__dirname, '..')
const electronVersion = require(path.join(root, 'node_modules/electron/package.json')).version

function contextArch(context) {
  const arch = typeof context.arch === 'number' ? Arch[context.arch] : context.arch
  if (!['arm64', 'x64', 'universal'].includes(arch)) {
    throw new Error(`Unsupported capture package architecture: ${String(arch)}`)
  }
  return arch
}

function copiedCaptureLayout(context) {
  const platform = context.electronPlatformName
  const arch = contextArch(context)
  const universalIntermediate =
    platform === 'darwin' && /-universal-(?:x64|arm64)-temp$/.test(context.appOutDir)
  if (platform === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`
    const appPath = path.join(context.appOutDir, appName)
    const expectedTargets = arch === 'universal' || universalIntermediate
      ? 'darwin-universal'
      : `darwin-${arch}`
    return {
      platform,
      appPath,
      universalIntermediate,
      engines: path.join(appPath, 'Contents', 'Resources', 'engines'),
      expectedTargets
    }
  }
  if (platform === 'win32') {
    if (arch !== 'x64') throw new Error(`Windows capture packaging is x64 only: ${arch}`)
    return {
      platform,
      appPath: null,
      universalIntermediate: false,
      engines: path.join(context.appOutDir, 'resources', 'engines'),
      expectedTargets: 'win32-x64'
    }
  }
  throw new Error(`Unsupported capture package platform: ${platform}`)
}

function verifyCopiedCapture(context, overrides = {}) {
  const layout = copiedCaptureLayout(context)
  const verify = overrides.verifySnapshot || verifyCaptureSnapshot
  verify(layout.engines, {
    expectedTargets: layout.expectedTargets,
    electronVersion: overrides.electronVersion || electronVersion,
    expectedSourceStamp: overrides.sourceStamp || sourceFingerprint()
  })
  return layout
}

async function afterPack(context) {
  // Verify the bytes electron-builder actually copied, not merely the mutable
  // source snapshot checked before packaging. This closes the final check/copy
  // race and runs on both desktop platforms and every universal stage.
  const layout = verifyCopiedCapture(context)
  if (layout.platform !== 'darwin') return
  // electron-builder calls afterPack for both thin temporary apps before
  // @electron/universal merges them. Signing those intermediates regenerates
  // architecture-specific CodeResources files, which the merger correctly
  // rejects as non-identical. The hook runs once more for the final universal
  // bundle, so leave only the intermediates unsigned.
  if (layout.universalIntermediate) {
    console.log('  • universal intermediate — deferring ad-hoc sign')
    return
  }
  const appName = path.basename(layout.appPath)
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', layout.appPath], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', layout.appPath], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${appName}`)
}

module.exports = afterPack
module.exports.copiedCaptureLayout = copiedCaptureLayout
module.exports.verifyCopiedCapture = verifyCopiedCapture
