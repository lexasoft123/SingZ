#!/usr/bin/env node

const { cpSync, mkdirSync, statSync, writeFileSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { dirname, join, resolve } = require('node:path')
const {
  packageRoot,
  machCanonicalSha256,
  replacePathPreserving,
  sha256File,
  uniqueGeneration,
  verifyCaptureSnapshot
} = require('./capture-artifact.cjs')

if (process.platform !== 'darwin') throw new Error('Universal capture snapshots can only be built on macOS')
const root = resolve(__dirname, '..')
const electronVersion = require(join(root, 'node_modules/electron/package.json')).version

if (!process.env.SINGZ_NATIVE_BUILD_LOCK_HELD) {
  const locked = spawnSync(process.execPath, [
    join(root, 'scripts', 'with-native-build-lock.mjs'),
    '--owner', 'capture-universal:darwin',
    '--', process.execPath, __filename, ...process.argv.slice(2)
  ], { cwd: process.cwd(), stdio: 'inherit' })
  if (locked.error) throw locked.error
  process.exit(locked.status ?? 1)
}
require('./native-build-lock.cjs').assertNativeBuildLockHeld(
  root, process.env.SINGZ_NATIVE_BUILD_LOCK_HELD
)

function input(target) {
  const rootPath = packageRoot(root, target)
  return verifyCaptureSnapshot(rootPath, {
    expectedTargets: target,
    electronVersion
  })
}

function copySnapshot(source, target) {
  const destination = packageRoot(root, target)
  const staging = `${destination}.part-universal-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(dirname(staging), { recursive: true })
  cpSync(source, staging, { recursive: true })
  verifyCaptureSnapshot(staging, {
    expectedTargets: 'darwin-universal',
    electronVersion
  })
  replacePathPreserving(staging, destination)
}

const arm64 = input('darwin-arm64')
const x64 = input('darwin-x64')
if (
  arm64.manifest.sourceStamp !== x64.manifest.sourceStamp ||
  arm64.manifest.electronVersion !== x64.manifest.electronVersion
) throw new Error('Universal capture inputs were not built from the same Electron/source tree')
if (
  arm64.manifest.codecRuntime?.profile !== x64.manifest.codecRuntime?.profile ||
  arm64.manifest.codecRuntime?.capabilityMask !== x64.manifest.codecRuntime?.capabilityMask
) throw new Error('Universal capture inputs do not carry the same FFmpeg product profile')

const universalRoot = packageRoot(root, 'darwin-universal')
const staging = `${universalRoot}.part-${process.pid}`
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
const addon = join(staging, 'singz-capture.node')
const result = spawnSync('lipo', [x64.addonPath, arm64.addonPath, '-create', '-output', addon], {
  stdio: 'inherit'
})
if (result.status !== 0) throw new Error(`lipo exited with ${result.status}`)
// A base build — no proven codec pack, which is what CI produces — carries no
// codecRuntime at all, and the universal snapshot then carries none either.
const codecRuntime = arm64.manifest.codecRuntime && x64.manifest.codecRuntime
  ? { arm64: arm64.manifest.codecRuntime, x64: x64.manifest.codecRuntime }
  : null
const codecLibraries = []
for (const armLibrary of codecRuntime ? codecRuntime.arm64.libraries : []) {
  const x64Library = codecRuntime.x64.libraries.find(
    (row) => row.component === armLibrary.component
  )
  if (!x64Library || x64Library.path !== armLibrary.path)
    throw new Error(`Universal FFmpeg ${armLibrary.component} inputs disagree`)
  const output = join(staging, armLibrary.path)
  mkdirSync(dirname(output), { recursive: true })
  const merged = spawnSync('lipo', [
    join(dirname(x64.addonPath), x64Library.path),
    join(dirname(arm64.addonPath), armLibrary.path),
    '-create', '-output', output
  ], { stdio: 'inherit' })
  if (merged.status !== 0)
    throw new Error(`FFmpeg ${armLibrary.component} lipo exited with ${merged.status}`)
  codecLibraries.push({
    component: armLibrary.component,
    path: armLibrary.path,
    bytes: statSync(output).size,
    sha256: sha256File(output),
    machCanonicalSha256: machCanonicalSha256(output)
  })
}
const artifactSha256 = sha256File(addon)
const canonicalSha256 = machCanonicalSha256(addon)
const manifest = {
  format: 1,
  target: 'darwin-universal',
  platform: 'darwin',
  arch: 'universal',
  electronVersion: arm64.manifest.electronVersion,
  sourceStamp: arm64.manifest.sourceStamp,
  artifactSha256,
  machCanonicalSha256: canonicalSha256,
  generation: uniqueGeneration(),
  addon: 'singz-capture.node',
  ...(codecRuntime ? {
    codecRuntime: {
      format: 1,
      profile: codecRuntime.arm64.profile,
      target: 'darwin-universal',
      capabilityMask: codecRuntime.arm64.capabilityMask,
      sourcePackManifestSha256: [
        codecRuntime.arm64.packManifestSha256,
        codecRuntime.x64.packManifestSha256
      ].sort(),
      libraries: codecLibraries
    }
  } : {})
}
writeFileSync(`${addon}.source-hash`, `${manifest.sourceStamp}\n`)
writeFileSync(`${addon}.sha256`, `${artifactSha256}\n`)
writeFileSync(join(staging, 'singz-capture.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
verifyCaptureSnapshot(staging, {
  expectedTargets: 'darwin-universal',
  electronVersion,
  expectedSourceStamp: manifest.sourceStamp
})
replacePathPreserving(staging, universalRoot)

// electron-builder stages each thin app from its arch-specific source before
// @electron/universal merges them. Give both stages the identical already-fat
// addon and metadata; x64ArchFiles tells universal not to lipo it twice.
copySnapshot(universalRoot, 'darwin-arm64')
copySnapshot(universalRoot, 'darwin-x64')
console.log('Capture package snapshot: build/capture-package/darwin-universal (arm64 + x64)')
