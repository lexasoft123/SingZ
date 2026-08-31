#!/usr/bin/env node

const { cpSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
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

const universalRoot = packageRoot(root, 'darwin-universal')
const staging = `${universalRoot}.part-${process.pid}`
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
const addon = join(staging, 'singz-capture.node')
const result = spawnSync('lipo', [x64.addonPath, arm64.addonPath, '-create', '-output', addon], {
  stdio: 'inherit'
})
if (result.status !== 0) throw new Error(`lipo exited with ${result.status}`)
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
  addon: 'singz-capture.node'
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
