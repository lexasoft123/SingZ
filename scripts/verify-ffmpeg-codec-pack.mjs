#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateFfmpegRuntimeBytes } from './ffmpeg-runtime-binary.mjs'
import { validateTargetProofReceipt } from './codec-target-proof-contract.mjs'
import { validateHostProofReceipt } from './codec-host-proof-contract.mjs'
import { assertExactManifestTree } from './strict-pack-files.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const profilePath = join(root, 'third_party', 'ffmpeg-codec', 'profile.json')
const profile = JSON.parse(readFileSync(profilePath, 'utf8'))

const valueAfter = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length)
    throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}
const explicitPack = process.argv.includes('--pack') ? valueAfter('--pack') : null
const target = process.argv.includes('--target') ? valueAfter('--target') : null
if (!explicitPack && !target)
  throw new Error('Usage: verify-ffmpeg-codec-pack.mjs --target <target> [--require-full] or --pack <directory>')
const pack = resolve(explicitPack || join(root, 'vendor', 'ffmpeg-codec', target))
const manifestPath = join(pack, 'manifest.json')
if (!existsSync(manifestPath)) throw new Error(`Missing FFmpeg pack manifest: ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const safeRelative = (path) =>
  typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
  !path.includes('\\') && !path.split('/').includes('..')
const exactArray = (actual, expected, label) => {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label} does not match the pinned SingZ codec profile`)
}

if (manifest.format !== 1 || manifest.profile !== profile.profile)
  throw new Error('Unsupported or wrong FFmpeg pack profile')
if (!profile.targets.includes(manifest.target))
  throw new Error(`Unrecognized FFmpeg target: ${manifest.target}`)
if (target && manifest.target !== target)
  throw new Error(`FFmpeg pack target is ${manifest.target}, expected ${target}`)
for (const field of ['version', 'url', 'sha256', 'license']) {
  if (manifest.source?.[field] !== profile.source[field])
    throw new Error(`FFmpeg pack source ${field} is not pinned`)
}
if (JSON.stringify(manifest.abiMajors) !== JSON.stringify(profile.abiMajors))
  throw new Error('FFmpeg pack ABI majors do not match the pinned headers')
if (manifest.capabilityMask !== profile.capabilityMask)
  throw new Error('FFmpeg pack does not claim the complete product capability mask')
exactArray(manifest.requiredDemuxers, profile.requiredDemuxers, 'demuxer set')
exactArray(manifest.requiredDecoders, profile.requiredDecoders, 'decoder set')
exactArray(manifest.requiredParsers, profile.requiredParsers, 'parser set')

const configuration = manifest.configuration
if (typeof configuration !== 'string' || configuration.length > 32768)
  throw new Error('FFmpeg pack has no bounded configure evidence')
for (const forbidden of profile.forbiddenConfigureFlags) {
  if (configuration.includes(forbidden))
    throw new Error(`Forbidden FFmpeg configure flag: ${forbidden}`)
}
for (const required of [
  '--disable-everything',
  '--disable-static',
  '--enable-shared',
  '--disable-network',
  `--enable-demuxer=${profile.requiredDemuxers.join(',')}`,
  `--enable-decoder=${profile.requiredDecoders.join(',')}`,
  `--enable-parser=${profile.requiredParsers.join(',')}`,
]) {
  if (!configuration.split(/\s+/).includes(required))
    throw new Error(`FFmpeg pack is missing configure flag: ${required}`)
}
const androidCompilers = {
  'android-arm64-v8a': 'aarch64-linux-android21-clang',
  'android-armeabi-v7a': 'armv7a-linux-androideabi21-clang',
  'android-x86': 'i686-linux-android21-clang',
  'android-x86_64': 'x86_64-linux-android21-clang',
}
if (androidCompilers[manifest.target] &&
    !configuration.includes(androidCompilers[manifest.target]))
  throw new Error(`FFmpeg pack has no ${manifest.target} Android API 21 compiler evidence`)

const files = manifest.files
if (!Array.isArray(files) || files.length < 8 || files.length > 4096)
  throw new Error('FFmpeg pack file manifest is missing or unreasonable')
const seen = new Set()
for (const file of files) {
  if (!safeRelative(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || seen.has(file.path))
    throw new Error(`Malformed FFmpeg pack file row: ${JSON.stringify(file)}`)
  seen.add(file.path)
  const absolute = join(pack, file.path)
  if (!existsSync(absolute) || !statSync(absolute).isFile())
    throw new Error(`Missing FFmpeg pack file: ${file.path}`)
  if (statSync(absolute).size !== file.bytes || sha256(absolute) !== file.sha256)
    throw new Error(`FFmpeg pack file changed after publication: ${file.path}`)
}
assertExactManifestTree({
  root: pack,
  rows: files,
  allowedRootFiles: ['manifest.json'],
  label: 'FFmpeg codec pack',
})

const runtimeLibraries = manifest.runtimeLibraries
if (runtimeLibraries == null || typeof runtimeLibraries !== 'object')
  throw new Error('FFmpeg pack has no runtime-library map')
const components = ['avcodec', 'avformat', 'avutil', 'swresample']
exactArray(Object.keys(runtimeLibraries).sort(), [...components].sort(), 'runtime library set')

for (const component of components) {
  const relativeLibrary = runtimeLibraries[component]
  if (!safeRelative(relativeLibrary) || !seen.has(relativeLibrary))
    throw new Error(`FFmpeg ${component} runtime is outside the immutable manifest`)
  const bytes = readFileSync(join(pack, relativeLibrary))
  validateFfmpegRuntimeBytes({
    bytes,
    target: manifest.target,
    component,
    profile,
    path: relativeLibrary,
  })
  // libavcodec_configuration() is emitted into each library from the same
  // build. Requiring the profile tokens in the shipped bytes catches a pack
  // manifest copied over a different or partial runtime.
  if (component === 'avcodec' || component === 'avformat') {
    for (const alternatives of [
      ['--disable-everything'],
      [`--enable-demuxer=${profile.requiredDemuxers.join(',')}`,
       `--enable-demuxer='${profile.requiredDemuxers.join(',')}'`],
      [`--enable-decoder=${profile.requiredDecoders.join(',')}`,
       `--enable-decoder='${profile.requiredDecoders.join(',')}'`],
    ]) {
      if (!alternatives.some((token) => bytes.includes(Buffer.from(token))))
        throw new Error(`FFmpeg ${component} binary does not contain ${alternatives[0]}`)
    }
  }
}

for (const name of ['NOTICE-FFMPEG.md', 'COPYING.LGPLv2.1-FFMPEG', 'profile.json']) {
  if (!seen.has(`compliance/${name}`))
    throw new Error(`FFmpeg pack does not ship compliance/${name}`)
}

let fullMatrixVerified = false
if (manifest.fixtureEvidence?.fullMatrix) {
  const receiptPath = manifest.fixtureEvidence.receiptPath
  if (!safeRelative(receiptPath) || receiptPath !== 'compliance/fixture-receipt.json' ||
      !seen.has(receiptPath))
    throw new Error('FFmpeg pack fixture evidence is outside the immutable file manifest')
  const receiptBytes = readFileSync(join(pack, receiptPath))
  if (sha256(join(pack, receiptPath)) !== manifest.fixtureEvidence.receiptSha256)
    throw new Error('FFmpeg pack fixture receipt hash does not match its evidence record')
  const receipt = JSON.parse(receiptBytes.toString('utf8'))
  const configurationSha256 = createHash('sha256')
    .update(manifest.configuration).digest('hex')
  if (manifest.fixtureEvidence.configurationSha256 !== configurationSha256)
    throw new Error('FFmpeg pack fixture receipt is not bound to this configuration')
  const mobileTarget = manifest.target.startsWith('android-') || manifest.target.startsWith('ios-')
  if (mobileTarget) {
    const sourceManifestPath = manifest.fixtureEvidence.sourceManifestPath
    if (sourceManifestPath !== 'compliance/proof-source-manifest.json' ||
        !seen.has(sourceManifestPath) ||
        sha256(join(pack, sourceManifestPath)) !== manifest.fixtureEvidence.sourceManifestSha256)
      throw new Error('Mobile target receipt has no preserved executed source manifest')
    validateTargetProofReceipt({
      receipt,
      profile,
      target: manifest.target,
      pack,
      root,
      sourceManifestPath: join(pack, sourceManifestPath),
    })
    fullMatrixVerified = true
  } else {
    if (receipt.format === 2) {
      const boundRuntimeLibraries = Object.fromEntries(
        Object.entries(runtimeLibraries).map(([component, path]) => [component, {
          path,
          bytes: statSync(join(pack, path)).size,
          sha256: sha256(join(pack, path)),
        }]),
      )
      validateHostProofReceipt({
        receipt,
        root,
        profile,
        target: manifest.target,
        configurationSha256,
        runtimeLibraries: boundRuntimeLibraries,
      })
      fullMatrixVerified = true
    } else if (process.argv.includes('--require-full')) {
      throw new Error(
        'Host fixture receipt predates canonical source/build/output binding; rerun the host proof',
      )
    }
  }
  for (const [component, path] of fullMatrixVerified ? Object.entries(runtimeLibraries) : []) {
    const runtimeSha256 = sha256(join(pack, path))
    const receiptRuntime = mobileTarget
      ? receipt.execution?.runtimeLibraries?.[component]
      : receipt.runtimeLibraries?.[component]
    // iOS executes the selected XCFramework slice; that may be a universal
    // simulator binary rather than this thin source pack. Its exact binding
    // is validated through the packaged selection receipt above.
    const receiptRuntimeMismatch = mobileTarget
      ? (!manifest.target.startsWith('ios-') && receiptRuntime?.sha256 !== runtimeSha256)
      : (receiptRuntime?.path !== path || receiptRuntime?.sha256 !== runtimeSha256)
    if (receiptRuntimeMismatch ||
        manifest.fixtureEvidence.runtimeSha256?.[component] !== runtimeSha256)
      throw new Error(`FFmpeg pack fixture receipt does not bind ${component}`)
  }
} else if (process.argv.includes('--require-full')) {
  throw new Error(
    'FFmpeg pack has configuration evidence but no full fixture decode evidence; run codec_provisioning_tests and publish its receipt',
  )
}

console.log(
  `FFmpeg codec pack verified: ${basename(pack)} · ${manifest.target} · ${manifest.files.length} files · full profile${fullMatrixVerified ? ' + fixtures' : ' (configuration only)'}`,
)
