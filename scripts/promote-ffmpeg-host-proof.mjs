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
import { validateHostProofReceipt } from './codec-host-proof-contract.mjs'

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
if (!/^(?:darwin-(?:arm64|x64)|win32-x64)$/.test(target))
  throw new Error(`Host proof promotion does not support ${target}`)

if (!process.env.SINGZ_NATIVE_BUILD_LOCK_HELD) {
  const locked = spawnSync(process.execPath, [
    join(root, 'scripts', 'with-native-build-lock.mjs'),
    '--owner', `ffmpeg-host-proof-promotion:${target}`,
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
  throw new Error(`Missing source pack or host receipt for ${target}`)
const profile = JSON.parse(
  readFileSync(join(root, 'third_party', 'ffmpeg-codec', 'profile.json'), 'utf8'),
)
const sourceManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const receiptBytes = readFileSync(receiptPath)
const receipt = JSON.parse(receiptBytes.toString('utf8'))
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha256 = (path) => sha256Bytes(readFileSync(path))
const collectFiles = (directory) => {
  const files = []
  const walk = (current, prefix = '') => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path, name)
      else if (entry.isFile() && name !== 'manifest.json') files.push({
        path: name, bytes: statSync(path).size, sha256: sha256(path),
      })
      else if (!entry.isFile()) throw new Error(`Unsupported promoted pack entry: ${path}`)
    }
  }
  walk(directory)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}
// A stale proof must not make an otherwise immutable source pack impossible
// to promote. Check its complete byte ledger here without accepting the stale
// receipt semantically; the replacement receipt and resulting pack are both
// validated against the current contract below.
if (JSON.stringify(collectFiles(output)) !== JSON.stringify(sourceManifest.files))
  throw new Error(`Source codec pack byte ledger is stale for ${target}`)
const configurationSha256 = sha256Bytes(Buffer.from(sourceManifest.configuration, 'utf8'))
const runtimeLibraries = Object.fromEntries(
  Object.entries(sourceManifest.runtimeLibraries).map(([component, path]) => [component, {
    path,
    bytes: statSync(join(output, path)).size,
    sha256: sha256(join(output, path)),
  }]),
)
validateHostProofReceipt({
  receipt, root, profile, target, configurationSha256, runtimeLibraries,
})

const partial = `${output}.part-host-proof-${process.pid}-${Date.now()}`
const backup = `${output}.backup-host-proof-${process.pid}-${Date.now()}`
rmSync(partial, { recursive: true, force: true })
rmSync(backup, { recursive: true, force: true })
cpSync(output, partial, { recursive: true, dereference: true })
mkdirSync(join(partial, 'compliance'), { recursive: true })
const receiptRelative = 'compliance/fixture-receipt.json'
writeFileSync(join(partial, receiptRelative), receiptBytes)
const files = collectFiles(partial)
const manifest = {
  ...sourceManifest,
  fixtureEvidence: {
    fullMatrix: true,
    mode: 'actual-host-runtime',
    receiptPath: receiptRelative,
    receiptSha256: sha256Bytes(receiptBytes),
    configurationSha256,
    runtimeSha256: Object.fromEntries(
      Object.entries(runtimeLibraries).map(([component, row]) => [component, row.sha256]),
    ),
  },
  files,
}
writeFileSync(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
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
console.log(`Promoted host-executed codec proof: ${relative(root, output)}`)
