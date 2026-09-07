#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertExactSelectionTree } from '../../scripts/strict-pack-files.mjs'
import { codecRuntimeMode, packHasFullMatrixEvidence } from './ffmpeg-codec-selection-policy.mjs'

// RNAudioAPI already owns the one final libav* runtime set in both mobile
// products. Installing a second copy under SingzCore would create duplicate
// install names/symbols. Promote the verified SingZ packs by replacing that
// dependency's staging inputs before CocoaPods/Gradle resolve them, then bind
// every selected byte to the immutable product manifest in a local receipt.
const here = dirname(fileURLToPath(import.meta.url))
// SINGZ_CODEC_SELECTION_ROOT is a test seam: the packaging suite points the
// selector at an isolated checkout-shaped fixture instead of this tree.
const repo = process.env.SINGZ_CODEC_SELECTION_ROOT
  ? resolve(process.env.SINGZ_CODEC_SELECTION_ROOT)
  : resolve(here, '..', '..')
const dependency = join(repo, 'mobile', 'node_modules', 'react-native-audio-api')
const external = join(dependency, 'common', 'cpp', 'audioapi', 'external')
const receiptPath = join(external, 'singz-ffmpeg-selection.json')
// A receipt present before this run means RNAudioAPI's bytes were already
// replaced once. The first selection on a fresh dependency preserves the
// originals beside the receipt so deselection can restore them offline.
const hadReceipt = existsSync(receiptPath)
const compatibilityRoot = join(dependency, '.singz-compatibility-runtime')
const compatibilityUnits = join(compatibilityRoot, 'units.json')
const profile = JSON.parse(
  readFileSync(join(repo, 'third_party', 'ffmpeg-codec', 'profile.json'), 'utf8'),
)
if (!existsSync(dependency)) {
  throw new Error('react-native-audio-api is not installed; run npm ci in mobile first')
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const safeRelative = (path) =>
  typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
  !path.includes('\\') && !path.split('/').includes('..')
const readManifest = (pack) => {
  const manifestPath = join(pack, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`Missing product FFmpeg manifest: ${manifestPath}`)
  const bytes = readFileSync(manifestPath)
  return {
    manifest: JSON.parse(bytes.toString('utf8')),
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
const nonce = () => `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
const preserveCompatibility = (destination) => {
  if (hadReceipt || !existsSync(destination)) return
  const unit = relative(dependency, destination).replaceAll('\\', '/')
  if (!safeRelative(unit)) throw new Error(`Unsafe compatibility unit: ${unit}`)
  const preserved = join(compatibilityRoot, unit)
  if (existsSync(preserved)) return
  mkdirSync(dirname(preserved), { recursive: true })
  renameSync(destination, preserved)
  const units = existsSync(compatibilityUnits)
    ? JSON.parse(readFileSync(compatibilityUnits, 'utf8'))
    : []
  if (!units.includes(unit)) {
    writeFileSync(compatibilityUnits, `${JSON.stringify([...units, unit].sort(), null, 2)}\n`)
  }
}
const restoreCompatibilityRuntime = () => {
  if (!hadReceipt) return
  if (!existsSync(compatibilityUnits)) {
    throw new Error(
      "A previous FFmpeg product selection replaced react-native-audio-api's runtime and no " +
      'preserved compatibility copy exists; restore the prebuilt binaries with ' +
      'scripts/worktree-setup.sh (or a fresh npm ci in mobile), then rerun this selector',
    )
  }
  const units = JSON.parse(readFileSync(compatibilityUnits, 'utf8'))
  for (const unit of units) {
    if (!safeRelative(unit)) throw new Error(`Unsafe preserved compatibility unit: ${unit}`)
    const preserved = join(compatibilityRoot, unit)
    if (!existsSync(preserved)) throw new Error(`Preserved compatibility unit is missing: ${unit}`)
    const destination = join(dependency, unit)
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(preserved, destination)
  }
  rmSync(compatibilityRoot, { recursive: true, force: true })
  rmSync(receiptPath, { force: true })
  console.log('FFmpeg product selector: restored the react-native-audio-api compatibility runtime')
}
const replacePath = (source, destination, directory) => {
  mkdirSync(dirname(destination), { recursive: true })
  preserveCompatibility(destination)
  const suffix = nonce()
  const partial = `${destination}.part-${suffix}`
  const backup = `${destination}.backup-${suffix}`
  rmSync(partial, { recursive: true, force: true })
  if (directory) cpSync(source, partial, { recursive: true, dereference: true })
  else copyFileSync(source, partial)
  if (!existsSync(destination)) {
    renameSync(partial, destination)
    return
  }
  renameSync(destination, backup)
  try {
    renameSync(partial, destination)
    rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    try { renameSync(backup, destination) } catch (rollback) {
      throw new AggregateError([error, rollback], `Could not install or restore ${destination}`)
    }
    throw error
  } finally {
    rmSync(partial, { recursive: true, force: true })
  }
}
const atomicWrite = (path, contents) => {
  const suffix = nonce()
  const partial = `${path}.part-${suffix}`
  const backup = `${path}.backup-${suffix}`
  writeFileSync(partial, contents)
  if (!existsSync(path)) {
    renameSync(partial, path)
    return
  }
  renameSync(path, backup)
  try {
    renameSync(partial, path)
    rmSync(backup, { force: true })
  } catch (error) {
    try { renameSync(backup, path) } catch (rollback) {
      throw new AggregateError([error, rollback], `Could not install or restore ${path}`)
    }
    throw error
  } finally {
    rmSync(partial, { force: true })
  }
}
const rowsFor = (manifest, sourcePrefix, destinationPrefix) => {
  const prefix = `${sourcePrefix}/`
  const rows = manifest.files
    .filter((row) => row.path.startsWith(prefix))
    .map((row) => ({
      source: row.path,
      destination: `${destinationPrefix}/${row.path.slice(prefix.length)}`,
      bytes: row.bytes,
      sha256: row.sha256,
    }))
  if (rows.length === 0) throw new Error(`FFmpeg pack has no ${sourcePrefix} payload`)
  return rows
}

const requireIos = process.argv.includes('--require-ios')
const proofStaging = process.argv.includes('--proof-staging')
if (proofStaging && process.env.SINGZ_CODEC_TARGET_PROOF !== '1') {
  throw new Error(
    '--proof-staging is restricted to the target proof harness; set SINGZ_CODEC_TARGET_PROOF=1 explicitly',
  )
}
const requireAndroidIndex = process.argv.indexOf('--require-android')
const requiredAndroidAbi = requireAndroidIndex >= 0 ? process.argv[requireAndroidIndex + 1] : null
if (requireAndroidIndex >= 0 && !requiredAndroidAbi)
  throw new Error('--require-android requires an ABI')
const requireAndroidSetIndex = process.argv.indexOf('--require-android-set')
const requiredAndroidSetValue = requireAndroidSetIndex >= 0
  ? process.argv[requireAndroidSetIndex + 1]
  : null
if (requireAndroidSetIndex >= 0 && !requiredAndroidSetValue)
  throw new Error('--require-android-set requires a comma-separated ABI set')
if (requiredAndroidAbi && requiredAndroidSetValue)
  throw new Error('Use --require-android or --require-android-set, not both')
const abiTargets = {
  'arm64-v8a': 'android-arm64-v8a',
  'armeabi-v7a': 'android-armeabi-v7a',
  x86: 'android-x86',
  x86_64: 'android-x86_64',
}
if (requiredAndroidAbi && !abiTargets[requiredAndroidAbi])
  throw new Error(`Unsupported Android ABI: ${requiredAndroidAbi}`)
const requiredAndroidAbis = requiredAndroidSetValue == null
  ? (requiredAndroidAbi == null ? [] : [requiredAndroidAbi])
  : requiredAndroidSetValue.split(',').filter(Boolean)
if (requiredAndroidAbis.length !== new Set(requiredAndroidAbis).size ||
    requiredAndroidAbis.some((abi) => !abiTargets[abi])) {
  throw new Error(`Unsupported or duplicate Android ABI set: ${requiredAndroidSetValue}`)
}
const hasPlatformRequirement = requireIos || requiredAndroidAbis.length > 0
const mode = codecRuntimeMode()
if (proofStaging && mode === 'off')
  throw new Error('SINGZ_FFMPEG_CODECS=off cannot stage a codec target proof')
// The proof harness and `required` fail closed on a missing or unproven pack.
// `auto`, the ordinary build, selects only packs that carry target fixture
// evidence and otherwise leaves RNAudioAPI's compatibility runtime in place,
// so zcore compiles its base WAV/FLAC decoder and reports exactly that.
const strict = mode === 'required' || proofStaging
const selectIos = mode !== 'off' && (requireIos || !hasPlatformRequirement)
const selectedAndroidAbis = mode === 'off'
  ? new Set()
  : requiredAndroidAbis.length > 0
    ? new Set(requiredAndroidAbis)
    : (requireIos ? new Set() : new Set(Object.keys(abiTargets)))
const verifyFull = !proofStaging
const skipped = []
if (mode === 'off') skipped.push('every product pack (SINGZ_FFMPEG_CODECS=off)')

const usablePack = (label, manifest) => {
  if (!verifyFull || packHasFullMatrixEvidence(manifest)) return true
  if (strict) {
    throw new Error(
      `${label} FFmpeg pack has configuration evidence but no full fixture decode evidence; ` +
      'run the target proof and promote its receipt',
    )
  }
  skipped.push(`${label}: configuration-only pack without target fixture evidence`)
  return false
}

let iosCandidate = null
const iosPack = join(repo, 'vendor', 'ffmpeg-codec', 'ios-xcframeworks')
if (selectIos && existsSync(join(iosPack, 'manifest.json'))) {
  const { manifest, manifestSha256 } = readManifest(iosPack)
  if (usablePack('ios-xcframeworks', manifest)) iosCandidate = { manifest, manifestSha256 }
} else if (requireIos && mode !== 'off') {
  if (strict) throw new Error(`Required product iOS FFmpeg pack is missing: ${iosPack}`)
  skipped.push(`ios-xcframeworks: no product pack at ${relative(repo, iosPack)}`)
}

const androidCandidates = []
for (const [abi, target] of Object.entries(abiTargets)) {
  if (!selectedAndroidAbis.has(abi)) continue
  const pack = join(repo, 'vendor', 'ffmpeg-codec', target)
  const required = requiredAndroidAbis.includes(abi)
  if (!existsSync(join(pack, 'manifest.json'))) {
    if (required && strict)
      throw new Error(`Required product Android FFmpeg pack is missing: ${pack}`)
    if (required) skipped.push(`${target}: no product pack at ${relative(repo, pack)}`)
    continue
  }
  const { manifest, manifestSha256 } = readManifest(pack)
  if (!usablePack(target, manifest)) continue
  androidCandidates.push({ abi, target, pack, manifest, manifestSha256 })
}
// One APK carries one codec capability: a required ABI set is selected whole
// or not at all, never as a mix of proven and compatibility runtimes.
if (requiredAndroidAbis.length > 0 && androidCandidates.length !== requiredAndroidAbis.length) {
  for (const candidate of androidCandidates)
    skipped.push(`${candidate.target}: proven, but the required ABI set is not fully proven`)
  androidCandidates.length = 0
}

const selections = []
let headerSource = null
if (iosCandidate) {
  const verifyArgs = [
    join(repo, 'scripts', 'verify-ffmpeg-ios-xcframeworks.mjs'), '--pack', iosPack,
  ]
  if (verifyFull) verifyArgs.push('--require-full')
  else verifyArgs.push('--proof-staging')
  execFileSync(process.execPath, verifyArgs, {
    stdio: 'inherit',
    env: proofStaging ? { ...process.env, SINGZ_CODEC_TARGET_PROOF: '1' } : process.env,
  })
  const { manifest, manifestSha256 } = iosCandidate
  const files = []
  for (const component of ['avcodec', 'avformat', 'avutil', 'swresample']) {
    const name = `lib${component}.xcframework`
    replacePath(join(iosPack, name), join(external, 'ffmpeg_ios', name), true)
    files.push(...rowsFor(
      manifest,
      name,
      `common/cpp/audioapi/external/ffmpeg_ios/${name}`,
    ))
  }
  selections.push({
    kind: 'ios-xcframeworks',
    target: 'ios-xcframeworks',
    pack: relative(repo, iosPack).replaceAll('\\', '/'),
    packManifestSha256: manifestSha256,
    files,
  })
  headerSource = { pack: iosPack, manifest, manifestSha256 }
}

for (const { abi, target, pack, manifest, manifestSha256 } of androidCandidates) {
  const verifyArgs = [
    join(repo, 'scripts', 'verify-ffmpeg-codec-pack.mjs'), '--pack', pack,
  ]
  if (verifyFull) verifyArgs.push('--require-full')
  execFileSync(process.execPath, verifyArgs, { stdio: 'inherit' })
  const files = []
  for (const [component, sourceRelative] of Object.entries(manifest.runtimeLibraries)) {
    if (!safeRelative(sourceRelative))
      throw new Error(`Unsafe ${target} ${component} runtime path: ${sourceRelative}`)
    const destinationRelative = `android/src/main/jniLibs/${abi}/lib${component}.so`
    replacePath(join(pack, sourceRelative), join(dependency, destinationRelative), false)
    files.push({
      source: sourceRelative,
      destination: destinationRelative,
      bytes: readFileSync(join(pack, sourceRelative)).length,
      sha256: sha256(join(pack, sourceRelative)),
    })
  }
  selections.push({
    kind: 'android-shared-libraries',
    target,
    abi,
    pack: relative(repo, pack).replaceAll('\\', '/'),
    packManifestSha256: manifestSha256,
    files: files.sort((left, right) => left.source.localeCompare(right.source)),
  })
  headerSource ??= { pack, manifest, manifestSha256 }
}

if (selections.length === 0) {
  restoreCompatibilityRuntime()
  for (const reason of skipped) console.log(`FFmpeg product selector: skipped ${reason}`)
  console.log(
    `FFmpeg product selector: no product pack selected (SINGZ_FFMPEG_CODECS=${mode}); ` +
    'compatibility runtime retained and native decode stays on base WAV/FLAC',
  )
  process.exit(0)
}

replacePath(join(headerSource.pack, 'include'), join(external, 'include_ffmpeg'), true)
const headers = {
  pack: relative(repo, headerSource.pack).replaceAll('\\', '/'),
  packManifestSha256: headerSource.manifestSha256,
  files: rowsFor(
    headerSource.manifest,
    'include',
    'common/cpp/audioapi/external/include_ffmpeg',
  ),
}
const receipt = {
  format: 1,
  mode: proofStaging ? 'target-proof-staging' : 'release-proven',
  profile: profile.profile,
  source: profile.source,
  selections,
  headers,
}
for (const selection of selections) {
  if (selection.kind === 'ios-xcframeworks') {
    assertExactSelectionTree({
      root: join(external, 'ffmpeg_ios'),
      rows: selection.files,
      destinationPrefix: 'common/cpp/audioapi/external/ffmpeg_ios',
      label: 'Selected iOS FFmpeg runtime',
    })
  } else {
    assertExactSelectionTree({
      root: join(dependency, 'android', 'src', 'main', 'jniLibs', selection.abi),
      rows: selection.files,
      destinationPrefix: `android/src/main/jniLibs/${selection.abi}`,
      label: `Selected Android FFmpeg runtime ${selection.abi}`,
    })
  }
}
assertExactSelectionTree({
  root: join(external, 'include_ffmpeg'),
  rows: headers.files,
  destinationPrefix: 'common/cpp/audioapi/external/include_ffmpeg',
  label: 'Selected FFmpeg headers',
})
atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(
  `FFmpeg product selector: ${selections.map((row) => row.target).join(', ')} ` +
  `→ react-native-audio-api (${selections.reduce((sum, row) => sum + row.files.length, 0)} runtime files; ${receipt.mode})`,
)
