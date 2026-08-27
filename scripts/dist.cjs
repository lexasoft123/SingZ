#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const {
  assertSourceFingerprintUnchanged,
  packageRoot,
  requestedCaptureTargets,
  verifyCaptureSnapshot
} = require('./capture-artifact.cjs')
const { sourceFingerprint } = require('./build-capture-addon.cjs')

const root = resolve(__dirname, '..')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function hasExplicitPublishArg(args) {
  return args.some((arg) =>
    arg === '--publish' || arg.startsWith('--publish=') || arg === '-p' || arg.startsWith('-p=')
  )
}

function electronBuilderArgs(args) {
  return hasExplicitPublishArg(args) ? [...args] : [...args, '--publish', 'never']
}

function finalVerifyCaptureSnapshots({
  projectRoot,
  targets,
  electronVersion,
  fingerprint = sourceFingerprint,
  verifySnapshot = verifyCaptureSnapshot
}) {
  const expectedSourceStamp = fingerprint()
  for (const target of targets) {
    verifySnapshot(packageRoot(projectRoot, target), {
      expectedTargets: target.startsWith('darwin-') ? [target, 'darwin-universal'] : target,
      electronVersion,
      expectedSourceStamp
    })
  }
  assertSourceFingerprintUnchanged(
    expectedSourceStamp,
    fingerprint(),
    'during final packaging verification'
  )
}

function main(builderArgs = process.argv.slice(2)) {
  const targets = requestedCaptureTargets(builderArgs)
  for (const target of targets) {
    run(process.execPath, [join(root, 'scripts/build-capture-addon.cjs'), target])
  }
  if (builderArgs.includes('--universal')) {
    run(process.execPath, [join(root, 'scripts/build-capture-universal.cjs')])
  }
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'])
  for (const target of targets) {
    run(process.execPath, [join(root, 'scripts/verify-capture-artifact.cjs'), target])
  }

  // Only the host architecture can be dlopen-smoked here; cross-architecture
  // artifacts are still checksum/manifest verified above and are load-smoked by
  // their native CI runner.
  const hostTarget = `${process.platform}-${process.arch}`
  if (targets.includes(hostTarget)) {
    const electron = require('electron')
    run(electron, [
      join(root, 'tests/e2e/capture-addon-smoke.cjs'),
      join(root, 'build/capture-package', hostTarget, 'singz-capture.node')
    ])
  }

  // This is intentionally the last operation before electron-builder reads
  // extraResources. It closes the build/verify -> source edit -> package gap.
  finalVerifyCaptureSnapshots({
    projectRoot: root,
    targets,
    electronVersion: require(join(root, 'node_modules/electron/package.json')).version
  })
  run(process.execPath, [
    require.resolve('electron-builder/cli.js'),
    ...electronBuilderArgs(builderArgs)
  ])
}

if (require.main === module) main()

module.exports = {
  electronBuilderArgs,
  finalVerifyCaptureSnapshots,
  hasExplicitPublishArg
}
