#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
const [target, stagingArgument] = process.argv.slice(2)
if (!target || !stagingArgument)
  throw new Error('Usage: finalize-ffmpeg-codec-runtime.mjs <target> <make-install-staging> [--fixture-receipt <json>]')
const staging = resolve(stagingArgument)
const profile = JSON.parse(
  readFileSync(join(root, 'third_party', 'ffmpeg-codec', 'profile.json'), 'utf8'),
)
if (!profile.targets.includes(target)) throw new Error(`Unsupported FFmpeg target: ${target}`)
if (!existsSync(join(staging, 'include', 'libavcodec', 'avcodec.h')))
  throw new Error(`FFmpeg staging tree has no installed headers: ${staging}`)
const configurationPath = join(staging, 'share', 'singz-ffmpeg', 'configuration.txt')
if (!existsSync(configurationPath))
  throw new Error('FFmpeg staging tree has no exact configure receipt')
const configuration = readFileSync(configurationPath, 'utf8').trim()

const receiptIndex = process.argv.indexOf('--fixture-receipt')
let fixtureEvidence = { fullMatrix: false }
let fixtureReceiptBytes = null
let fixtureReceipt = null
if (receiptIndex >= 0) {
  const receiptPath = process.argv[receiptIndex + 1]
  if (!receiptPath) throw new Error('--fixture-receipt requires a path')
  fixtureReceiptBytes = readFileSync(receiptPath)
  fixtureReceipt = JSON.parse(fixtureReceiptBytes.toString('utf8'))
  if (fixtureReceipt.format !== 2 || fixtureReceipt.profile !== profile.profile ||
      fixtureReceipt.target !== target ||
      fixtureReceipt.capabilityMask !== profile.capabilityMask ||
      fixtureReceipt.result !== 'full dynamic matrix ok')
    throw new Error('Codec fixture receipt does not prove this target and profile')
}

const output = join(root, 'vendor', 'ffmpeg-codec', target)
const partial = `${output}.part-${process.pid}-${Date.now()}`
if (existsSync(output)) {
  throw new Error(
    `Immutable FFmpeg pack already exists: ${output}; verify it or remove that exact target before rebuilding`,
  )
}
rmSync(partial, { recursive: true, force: true })
mkdirSync(partial, { recursive: true })

const copied = []
const copyTree = (source, destination, prefix = '') => {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const destinationPath = join(destination, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(destinationPath, { recursive: true })
      copyTree(sourcePath, destinationPath, relativePath)
      continue
    }
    // make install publishes version-selector symlinks. Packages own real
    // bytes so worktree sharing, ZIP extraction and Windows hosts cannot turn
    // a runtime into an absolute/broken link.
    const actual = entry.isSymbolicLink() ? realpathSync(sourcePath) : sourcePath
    if (!statSync(actual).isFile()) throw new Error(`Unsupported pack entry: ${sourcePath}`)
    mkdirSync(dirname(destinationPath), { recursive: true })
    copyFileSync(actual, destinationPath)
    copied.push(relativePath)
  }
}
for (const directory of ['include', 'lib', 'bin']) {
  const source = join(staging, directory)
  if (!existsSync(source)) continue
  mkdirSync(join(partial, directory), { recursive: true })
  copyTree(source, join(partial, directory), directory)
}
// FFmpeg's install target publishes its SDK examples even with --disable-doc.
// They are not runtime inputs and materially inflate every platform pack. The
// only staged share payload owned by the product is the exact configure
// receipt written by the builder.
const stagedReceiptDirectory = join(staging, 'share', 'singz-ffmpeg')
mkdirSync(join(partial, 'share', 'singz-ffmpeg'), { recursive: true })
copyTree(
  stagedReceiptDirectory,
  join(partial, 'share', 'singz-ffmpeg'),
  'share/singz-ffmpeg',
)

const compliance = join(partial, 'compliance')
mkdirSync(compliance, { recursive: true })
for (const [source, name] of [
  [join(root, 'third_party', 'NOTICE-FFMPEG.md'), 'NOTICE-FFMPEG.md'],
  [join(root, 'third_party', 'COPYING.LGPLv2.1-FFMPEG'), 'COPYING.LGPLv2.1-FFMPEG'],
  [join(root, 'third_party', 'ffmpeg-codec', 'profile.json'), 'profile.json'],
]) {
  copyFileSync(source, join(compliance, name))
  copied.push(`compliance/${name}`)
}
if (fixtureReceiptBytes != null) {
  writeFileSync(join(compliance, 'fixture-receipt.json'), fixtureReceiptBytes)
  copied.push('compliance/fixture-receipt.json')
}

const major = profile.abiMajors
const candidates = {
  avcodec: target.startsWith('win32-')
    ? [`bin/avcodec-${major.avcodec}.dll`]
    : target.startsWith('android-')
      ? ['lib/libavcodec.so']
      : [`lib/libavcodec.${major.avcodec}.dylib`, 'lib/libavcodec.dylib'],
  avformat: target.startsWith('win32-')
    ? [`bin/avformat-${major.avformat}.dll`]
    : target.startsWith('android-')
      ? ['lib/libavformat.so']
      : [`lib/libavformat.${major.avformat}.dylib`, 'lib/libavformat.dylib'],
  avutil: target.startsWith('win32-')
    ? [`bin/avutil-${major.avutil}.dll`]
    : target.startsWith('android-')
      ? ['lib/libavutil.so']
      : [`lib/libavutil.${major.avutil}.dylib`, 'lib/libavutil.dylib'],
  swresample: target.startsWith('win32-')
    ? [`bin/swresample-${major.swresample}.dll`]
    : target.startsWith('android-')
      ? ['lib/libswresample.so']
      : [`lib/libswresample.${major.swresample}.dylib`, 'lib/libswresample.dylib'],
}
const runtimeLibraries = {}
for (const [component, paths] of Object.entries(candidates)) {
  runtimeLibraries[component] = paths.find((path) => existsSync(join(partial, path)))
  if (!runtimeLibraries[component])
    throw new Error(`FFmpeg staging tree has no ${component} shared runtime for ${target}`)
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
if (fixtureReceipt != null) {
  const configurationSha256 = createHash('sha256').update(configuration).digest('hex')
  const boundRuntimeLibraries = Object.fromEntries(
    Object.entries(runtimeLibraries).map(([component, path]) => [component, {
      path,
      bytes: statSync(join(partial, path)).size,
      sha256: sha256(join(partial, path)),
    }]),
  )
  validateHostProofReceipt({
    receipt: fixtureReceipt,
    root,
    profile,
    target,
    configurationSha256,
    runtimeLibraries: boundRuntimeLibraries,
  })
  fixtureEvidence = {
    fullMatrix: true,
    receiptPath: 'compliance/fixture-receipt.json',
    receiptSha256: createHash('sha256').update(fixtureReceiptBytes).digest('hex'),
    configurationSha256,
    runtimeSha256: Object.fromEntries(
      Object.entries(runtimeLibraries).map(([component, path]) =>
        [component, sha256(join(partial, path))]),
    ),
  }
}
const files = [...new Set(copied)].sort().map((path) => ({
  path,
  bytes: statSync(join(partial, path)).size,
  sha256: sha256(join(partial, path)),
}))
const manifest = {
  format: 1,
  profile: profile.profile,
  target,
  source: profile.source,
  abiMajors: profile.abiMajors,
  capabilityMask: profile.capabilityMask,
  requiredDemuxers: profile.requiredDemuxers,
  requiredDecoders: profile.requiredDecoders,
  requiredParsers: profile.requiredParsers,
  configuration,
  runtimeLibraries,
  fixtureEvidence,
  files,
}
writeFileSync(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// A target pack is immutable. Publishing a new directory over a missing name
// is one rename; a killed build leaves only a .part directory that no consumer
// trusts. Replacing an existing directory would introduce a missing/half-new
// interval, so the explicit refusal above makes replacement a release action.
mkdirSync(dirname(output), { recursive: true })
renameSync(partial, output)
console.log(`Published FFmpeg codec pack: ${relative(root, output)} (${files.length} files)`)
