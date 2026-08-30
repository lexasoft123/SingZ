#!/usr/bin/env node
/**
 * Materialize the exact callback-safe zdsp Apple component into its local pod.
 * Top-level zdsp/ remains authoritative; CocoaPods cannot reliably glob or
 * retain source trees outside a podspec directory, so this generated copy is
 * read-only and ignored. Run with --check to fail on a stale/missing copy.
 */
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} = require('node:fs')
const { dirname, join } = require('node:path')
const { execFileSync } = require('node:child_process')
const {
  iosAudioHostCallbackFiles,
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

const files = [...zdspRuntimeFiles, ...zdspHostAdapterFiles]
const zcoreFiles = zdspSupportZcoreFiles
const callbackFiles = [
  ...zcoreDeviceCallbackFiles,
  ...iosAudioHostCallbackFiles,
  ...zcoreDeviceCallbackSupportFiles,
]

execFileSync(process.execPath, [
  join(__dirname, 'check-native-component-sources.js'),
], { stdio: 'inherit' })

const unlockTree = (dir) => {
  if (!existsSync(dir)) return
  chmodSync(dir, 0o755)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) unlockTree(path)
    else chmodSync(path, 0o644)
  }
}

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
  console.log(
    'sync-singz-dsp-runtime: verified ' +
      `${files.length + zcoreFiles.length + callbackFiles.length} files`
  )
  process.exit(0)
}

const materialize = (from, to, expectedFiles) => {
  unlockTree(to)
  rmSync(to, { recursive: true, force: true })
  for (const relative of expectedFiles) {
    const destination = join(to, relative)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(from, relative), destination)
    chmodSync(destination, 0o444)
  }
}
materialize(sourceRoot, destinationRoot, files)
materialize(zcoreSourceRoot, zcoreDestinationRoot, zcoreFiles)
materialize(zcoreSourceRoot, callbackDestinationRoot, callbackFiles)
console.log(
  'sync-singz-dsp-runtime: ' +
    `${files.length + zcoreFiles.length + callbackFiles.length} files ` +
    '→ ios/{SingzDspRuntime,SingzDeviceCallback}/'
)
