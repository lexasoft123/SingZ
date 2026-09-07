#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateTargetProofReceipt } from './codec-target-proof-contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const valueAfter = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length)
    throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}
const target = valueAfter('--target')
const receiptPath = resolve(valueAfter('--receipt'))
if (!/^android-(?:arm64-v8a|armeabi-v7a|x86|x86_64)$/.test(target) &&
    !/^ios-(?:arm64|simulator-(?:arm64|x64))$/.test(target))
  throw new Error(`Target proof promotion is mobile-only: ${target}`)

if (!process.env.SINGZ_NATIVE_BUILD_LOCK_HELD) {
  const locked = spawnSync(process.execPath, [
    join(root, 'scripts', 'with-native-build-lock.mjs'),
    '--owner', `ffmpeg-proof-promotion:${target}`,
    '--', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { cwd: process.cwd(), stdio: 'inherit' })
  if (locked.error) throw locked.error
  process.exit(locked.status ?? 1)
}
execFileSync(process.execPath, [join(root, 'scripts', 'assert-native-build-lock.cjs')], {
  stdio: 'inherit',
})

const output = join(root, 'vendor', 'ffmpeg-codec', target)
const manifestPath = join(output, 'manifest.json')
if (!existsSync(manifestPath) || !existsSync(receiptPath))
  throw new Error(`Missing source pack or target receipt for ${target}`)
execFileSync(process.execPath, [
  join(root, 'scripts', 'verify-ffmpeg-codec-pack.mjs'), '--pack', output,
], { stdio: 'inherit' })

const profile = JSON.parse(
  readFileSync(join(root, 'third_party', 'ffmpeg-codec', 'profile.json'), 'utf8'),
)
const sourceManifestBytes = readFileSync(manifestPath)
const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'))
if (sourceManifest.target !== target || sourceManifest.profile !== profile.profile)
  throw new Error('Source pack target/profile mismatch')
if (sourceManifest.fixtureEvidence?.fullMatrix === true)
  throw new Error(`FFmpeg target pack is already proof-promoted: ${output}`)
const receiptBytes = readFileSync(receiptPath)
const receipt = JSON.parse(receiptBytes.toString('utf8'))
validateTargetProofReceipt({ receipt, profile, target, pack: output, root })

const partial = `${output}.part-proof-${process.pid}-${Date.now()}`
const backup = `${output}.backup-proof-${process.pid}-${Date.now()}`
rmSync(partial, { recursive: true, force: true })
rmSync(backup, { recursive: true, force: true })
cpSync(output, partial, { recursive: true, dereference: true })
const compliance = join(partial, 'compliance')
mkdirSync(compliance, { recursive: true })
const sourceManifestRelative = 'compliance/proof-source-manifest.json'
const receiptRelative = 'compliance/fixture-receipt.json'
writeFileSync(join(partial, sourceManifestRelative), sourceManifestBytes)
writeFileSync(join(partial, receiptRelative), receiptBytes)

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha256 = (path) => sha256Bytes(readFileSync(path))
const files = []
const walk = (directory, prefix = '') => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(path, name)
    else if (entry.isFile() && name !== 'manifest.json') files.push({
      path: name,
      bytes: statSync(path).size,
      sha256: sha256(path),
    })
    else if (!entry.isFile()) throw new Error(`Unsupported promoted pack entry: ${path}`)
  }
}
walk(partial)
files.sort((left, right) => left.path.localeCompare(right.path))
const configurationSha256 = sha256Bytes(Buffer.from(sourceManifest.configuration, 'utf8'))
const runtimeSha256 = Object.fromEntries(
  Object.entries(sourceManifest.runtimeLibraries).map(([component, path]) => [
    component, sha256(join(partial, path)),
  ]),
)
const manifest = {
  ...sourceManifest,
  fixtureEvidence: {
    fullMatrix: true,
    mode: 'actual-packaged-runtime',
    receiptPath: receiptRelative,
    receiptSha256: sha256Bytes(receiptBytes),
    sourceManifestPath: sourceManifestRelative,
    sourceManifestSha256: sha256Bytes(sourceManifestBytes),
    configurationSha256,
    runtimeSha256,
  },
  files,
}
writeFileSync(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
validateTargetProofReceipt({
  receipt,
  profile,
  target,
  pack: partial,
  root,
  sourceManifestPath: join(partial, sourceManifestRelative),
})
execFileSync(process.execPath, [
  join(root, 'scripts', 'verify-ffmpeg-codec-pack.mjs'),
  '--pack', partial, '--require-full',
], { stdio: 'inherit' })

renameSync(output, backup)
try {
  renameSync(partial, output)
  rmSync(backup, { recursive: true, force: false })
} catch (error) {
  try {
    if (existsSync(output)) rmSync(output, { recursive: true, force: true })
    renameSync(backup, output)
  } catch (rollback) {
    throw new AggregateError([error, rollback], `Could not promote or restore ${output}`)
  }
  throw error
} finally {
  rmSync(partial, { recursive: true, force: true })
}
console.log(`Promoted target-executed codec proof: ${relative(root, output)}`)
