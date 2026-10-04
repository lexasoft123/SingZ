#!/usr/bin/env node
/**
 * Materialize the exact callback-safe zdsp Apple component into its local pod.
 * Top-level zdsp/ remains authoritative; CocoaPods cannot reliably glob or
 * retain source trees outside a podspec directory, so this generated copy is
 * read-only and ignored. Run with --check to fail on a stale/missing copy.
 */
const {
  existsSync,
  readFileSync,
  readdirSync,
} = require('node:fs')
const { join } = require('node:path')
const { createMirror } = require('./incremental-native-mirror.cjs')
const { execFileSync } = require('node:child_process')
const {
  iosAudioHostCallbackFiles,
  nativePlaybackCallbackFiles,
  nativePlaybackSessionFiles,
  nativePlaybackSessionSupportFiles,
  signalsmithTimePitchFiles,
  signalsmithVendorFiles,
  zcoreDeviceCallbackFiles,
  zcoreDeviceCallbackSupportFiles,
  zdspHostAdapterFiles,
  zdspRuntimeFiles,
  zdspSupportZcoreFiles,
} = require('./native-component-sources')

const check = process.argv.slice(2).includes('--check')
const mobileRoot = join(__dirname, '..')
const repoRoot = join(mobileRoot, '..')
const sourceRoot = join(repoRoot, 'zdsp')
const destinationRoot = join(mobileRoot, 'ios', 'SingzDspRuntime', 'zdsp')
const zcoreSourceRoot = join(repoRoot, 'zcore')
const zcoreDestinationRoot = join(
  mobileRoot, 'ios', 'SingzDspRuntime', 'zcore'
)
const callbackDestinationRoot = join(
  mobileRoot, 'ios', 'SingzDeviceCallback', 'zcore'
)
const nativeSourceRoot = join(repoRoot, 'native')
const playbackCallbackDestinationRoot = join(
  mobileRoot, 'ios', 'SingzDspRuntime', 'native'
)
const playbackSessionDestinationRoot = join(
  mobileRoot, 'ios', 'SingzPlaybackSession', 'native'
)
const signalsmithSourceRoot = join(
  repoRoot, 'third_party', 'native', 'signalsmith'
)
const signalsmithDestinationRoot = join(
  mobileRoot, 'ios', 'SingzPlaybackSession', 'signalsmith'
)
const signalsmithComplianceDestinationRoot = join(
  mobileRoot, 'ios', 'SingzPlaybackSession', 'compliance'
)
const signalsmithComplianceFiles = [
  'VENDORED.txt',
  'LICENSE-stretch.txt',
  'LICENSE-linear.txt',
]

const files = [...zdspRuntimeFiles, ...zdspHostAdapterFiles]
const zcoreFiles = zdspSupportZcoreFiles
const callbackFiles = [
  ...zcoreDeviceCallbackFiles,
  ...iosAudioHostCallbackFiles,
  ...zcoreDeviceCallbackSupportFiles,
]
const totalFiles = files.length + zcoreFiles.length + callbackFiles.length +
  nativePlaybackCallbackFiles.length + nativePlaybackSessionFiles.length +
  nativePlaybackSessionSupportFiles.length + signalsmithTimePitchFiles.length +
  signalsmithVendorFiles.length + signalsmithComplianceFiles.length

execFileSync(process.execPath, [
  join(__dirname, 'check-native-component-sources.js'),
], { stdio: 'inherit' })

const walk = (dir, actualFiles, relative = '') => {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(child, actualFiles, rel)
    else actualFiles.push(rel)
  }
}

const verify = (from, to, expectedFiles, label) => {
  const expected = new Set(expectedFiles)
  const actualFiles = []
  walk(to, actualFiles)
  const unexpected = actualFiles.filter((file) => !expected.has(file))
  const missing = expectedFiles.filter((file) => !actualFiles.includes(file))
  const changed = expectedFiles.filter((file) => {
    const destination = join(to, file)
    return existsSync(destination) &&
      !readFileSync(destination).equals(readFileSync(join(from, file)))
  })
  if (unexpected.length || missing.length || changed.length) {
    const parts = []
    if (missing.length) parts.push(`missing: ${missing.join(', ')}`)
    if (unexpected.length) parts.push(`unexpected: ${unexpected.join(', ')}`)
    if (changed.length) parts.push(`changed: ${changed.join(', ')}`)
    throw new Error(`${label} generated copy is stale (${parts.join('; ')})`)
  }
}

if (check) {
  verify(sourceRoot, destinationRoot, files, 'zdsp')
  verify(zcoreSourceRoot, zcoreDestinationRoot, zcoreFiles, 'zcore')
  verify(
    zcoreSourceRoot,
    callbackDestinationRoot,
    callbackFiles,
    'zcore callback'
  )
  verify(
    nativeSourceRoot,
    playbackCallbackDestinationRoot,
    nativePlaybackCallbackFiles,
    'native playback callback'
  )
  verify(
    nativeSourceRoot,
    playbackSessionDestinationRoot,
    [...nativePlaybackSessionFiles, ...nativePlaybackSessionSupportFiles,
      ...signalsmithTimePitchFiles],
    'native playback session'
  )
  verify(
    signalsmithSourceRoot,
    signalsmithDestinationRoot,
    signalsmithVendorFiles,
    'Signalsmith vendor'
  )
  verify(
    signalsmithSourceRoot,
    signalsmithComplianceDestinationRoot,
    signalsmithComplianceFiles,
    'Signalsmith compliance'
  )
  console.log(
    'sync-singz-dsp-runtime: verified ' +
      `${totalFiles} files`
  )
  process.exit(0)
}

const materialize = (from, to, expectedFiles) => {
  const mirror = createMirror(to)
  for (const relative of expectedFiles) mirror.copy(join(from, relative), join(to, relative))
  mirror.finish()
}
materialize(sourceRoot, destinationRoot, files)
materialize(zcoreSourceRoot, zcoreDestinationRoot, zcoreFiles)
materialize(zcoreSourceRoot, callbackDestinationRoot, callbackFiles)
materialize(
  nativeSourceRoot,
  playbackCallbackDestinationRoot,
  nativePlaybackCallbackFiles
)
materialize(
  nativeSourceRoot,
  playbackSessionDestinationRoot,
  [...nativePlaybackSessionFiles, ...nativePlaybackSessionSupportFiles,
    ...signalsmithTimePitchFiles]
)
materialize(
  signalsmithSourceRoot,
  signalsmithDestinationRoot,
  signalsmithVendorFiles
)
materialize(
  signalsmithSourceRoot,
  signalsmithComplianceDestinationRoot,
  signalsmithComplianceFiles
)
console.log(
  'sync-singz-dsp-runtime: ' +
    `${totalFiles} files ` +
    '→ ios/{SingzDspRuntime,SingzDeviceCallback,SingzPlaybackSession}/'
)
