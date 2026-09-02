#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateFfmpegFrameworkBytes,
  validateFfmpegRuntimeBytes,
} from '../../scripts/ffmpeg-runtime-binary.mjs'
import { assertExactSelectionTree } from '../../scripts/strict-pack-files.mjs'
import {
  codecRuntimeMode,
  readProductSelectionReceipt,
  resolveProductPackRoot,
} from './ffmpeg-codec-selection-policy.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// SINGZ_CODEC_SELECTION_ROOT is the packaging suite's test seam (see the
// selector); production runs always verify this checkout.
const repo = process.env.SINGZ_CODEC_SELECTION_ROOT
  ? resolve(process.env.SINGZ_CODEC_SELECTION_ROOT)
  : resolve(here, '..', '..')
const dependency = join(repo, 'mobile', 'node_modules', 'react-native-audio-api')
const sumsPath = join(repo, 'third_party', 'FFMPEG-SHA256SUMS')
const notice = join(repo, 'third_party', 'NOTICE-FFMPEG.md')
const license = join(repo, 'third_party', 'COPYING.LGPLv2.1-FFMPEG')
const profilePath = join(repo, 'third_party', 'ffmpeg-codec', 'profile.json')
for (const required of [sumsPath, notice, license, profilePath]) {
  if (!existsSync(required)) throw new Error(`Missing FFmpeg compliance file: ${required}`)
}
const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const safeRelative = (path) =>
  typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
  !path.includes('\\') && !path.split('/').includes('..')

const proofStaging = process.argv.includes('--proof-staging')
if (proofStaging && process.env.SINGZ_CODEC_TARGET_PROOF !== '1') {
  throw new Error(
    '--proof-staging is restricted to the target proof harness; set SINGZ_CODEC_TARGET_PROOF=1 explicitly',
  )
}
const requireFullArgument = process.argv.includes('--require-full')
if (proofStaging && requireFullArgument)
  throw new Error('--proof-staging cannot be combined with --require-full')
const requireIos = process.argv.includes('--require-ios')
const requireAndroidIndex = process.argv.indexOf('--require-android')
const requiredAndroidAbi = requireAndroidIndex >= 0 ? process.argv[requireAndroidIndex + 1] : null
const requireAndroidSetIndex = process.argv.indexOf('--require-android-set')
const requiredAndroidSetValue = requireAndroidSetIndex >= 0
  ? process.argv[requireAndroidSetIndex + 1]
  : null
if (requireAndroidIndex >= 0 && !requiredAndroidAbi)
  throw new Error('--require-android requires an ABI')
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
const requiredAndroidAbis = requiredAndroidSetValue == null
  ? (requiredAndroidAbi == null ? [] : [requiredAndroidAbi])
  : requiredAndroidSetValue.split(',').filter(Boolean)
if (requiredAndroidAbis.length !== new Set(requiredAndroidAbis).size ||
    requiredAndroidAbis.some((abi) => !abiTargets[abi]))
  throw new Error(`Unsupported or duplicate Android ABI set: ${requiredAndroidSetValue || requiredAndroidAbi}`)
const mode = codecRuntimeMode()
if (proofStaging && mode === 'off')
  throw new Error('SINGZ_FFMPEG_CODECS=off cannot verify a codec target proof')
// `required` and the proof harness demand a product selection; `auto` and
// `off` accept the compatibility runtime, which the selector leaves in place
// when no fully proven pack exists (see select-ffmpeg-codec-runtime.mjs).
const strict = mode === 'required' || proofStaging

const u32be = (bytes, offset) => bytes.readUInt32BE(offset)
const u32le = (bytes, offset) => bytes.readUInt32LE(offset)
const isMachDylibAt = (bytes, offset) => {
  if (offset + 16 > bytes.length) return false
  const magic = u32be(bytes, offset)
  if (magic === 0xcffaedfe || magic === 0xcefaedfe)
    return u32le(bytes, offset + 12) === 6
  if (magic === 0xfeedfacf || magic === 0xfeedface)
    return u32be(bytes, offset + 12) === 6
  return false
}
const isDynamicLibrary = (bytes) => {
  if (bytes.length < 20) return false
  if (bytes[0] === 0x7f && bytes.subarray(1, 4).toString('ascii') === 'ELF') {
    const little = bytes[5] === 1
    const type = little ? bytes.readUInt16LE(16) : bytes.readUInt16BE(16)
    return type === 3 // ET_DYN
  }
  if (isMachDylibAt(bytes, 0)) return true
  const magic = u32be(bytes, 0)
  if (magic !== 0xcafebabe || bytes.length < 8) return false
  const count = u32be(bytes, 4)
  if (count === 0 || count > 32 || bytes.length < 8 + count * 20) return false
  for (let index = 0; index < count; ++index) {
    const offset = u32be(bytes, 8 + index * 20 + 8)
    if (!isMachDylibAt(bytes, offset)) return false
  }
  return true
}

// A selector receipt means the compatibility bytes have deliberately been
// replaced with immutable SingZ product packs. Verify the selected copies
// against both their source manifests and current destinations. Falling back
// to RNAudioAPI's checksum table here would reject the intended replacement;
// accepting an unbound changed binary would be worse, so no middle state is
// allowed.
const selection = readProductSelectionReceipt({ dependency, profile, proofStaging })
const selectionReceiptPath = selection.path
if (selection.receipt !== null) {
  if (mode === 'off') {
    throw new Error(
      'SINGZ_FFMPEG_CODECS=off, but a product selection receipt is installed; rerun ' +
      'select-ffmpeg-codec-runtime.mjs to restore the compatibility runtime',
    )
  }
  const requireFull = !proofStaging
  const receipt = selection.receipt
  const selectedTargets = receipt.selections.map((row) => row?.target)
  const expectedTargets = [
    ...(requireIos ? ['ios-xcframeworks'] : []),
    ...requiredAndroidAbis.map((abi) => abiTargets[abi]),
  ]
  if (expectedTargets.length > 0 &&
      JSON.stringify([...selectedTargets].sort()) !== JSON.stringify([...expectedTargets].sort())) {
    throw new Error(
      `FFmpeg product selection target set is ${selectedTargets.join(',')}; expected ${expectedTargets.join(',')}`,
    )
  }

  const vendorRoot = resolve(repo, 'vendor', 'ffmpeg-codec')
  const isInside = (parent, child) => {
    const nested = relative(parent, child)
    return nested !== '' && safeRelative(nested.replaceAll('\\', '/'))
  }
  const openPack = (selection) => {
    const pack = resolveProductPackRoot({ repo, vendorRoot, selection })
    const manifestPath = join(pack, 'manifest.json')
    if (!existsSync(manifestPath) || sha256(manifestPath) !== selection.packManifestSha256)
      throw new Error(`FFmpeg product source manifest changed: ${selection.pack}`)
    return { pack, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }
  }
  const verifyRows = (selection, manifest, expectedSources) => {
    if (!Array.isArray(selection.files) ||
        JSON.stringify(selection.files.map((row) => row.source).sort()) !==
          JSON.stringify([...expectedSources].sort()))
      throw new Error(`FFmpeg selection file set is incomplete: ${selection.target || 'headers'}`)
    const sourceRows = new Map(manifest.files.map((row) => [row.path, row]))
    for (const row of selection.files) {
      if (!safeRelative(row.source) || !safeRelative(row.destination) ||
          !/^[0-9a-f]{64}$/.test(row.sha256) ||
          !Number.isSafeInteger(row.bytes) || row.bytes < 0)
        throw new Error(`Malformed selected FFmpeg file row: ${JSON.stringify(row)}`)
      const declared = sourceRows.get(row.source)
      if (declared?.sha256 !== row.sha256 || declared?.bytes !== row.bytes)
        throw new Error(`Selected FFmpeg source is not bound to its manifest: ${row.source}`)
      const destination = resolve(dependency, row.destination)
      if (!isInside(dependency, destination) || !existsSync(destination) ||
          !statSync(destination).isFile() || statSync(destination).size !== row.bytes ||
          sha256(destination) !== row.sha256)
        throw new Error(`Selected FFmpeg byte changed after staging: ${row.destination}`)
      const iosFrameworkBinary = row.source.match(
        /^lib(avcodec|avformat|avutil|swresample)\.xcframework\/(ios-arm64|ios-arm64_x86_64-simulator)\/lib\1\.framework\/lib\1$/,
      )
      if ((row.destination.endsWith('.so') || iosFrameworkBinary != null) &&
          !isDynamicLibrary(readFileSync(destination)))
        throw new Error(`Selected FFmpeg runtime is not dynamic: ${row.destination}`)
      if (row.destination.endsWith('.so')) {
        const component = Object.entries(manifest.runtimeLibraries ?? {})
          .find(([, path]) => path === row.source)?.[0]
        if (component == null)
          throw new Error(`Selected Android runtime is not in the component map: ${row.source}`)
        validateFfmpegRuntimeBytes({
          bytes: readFileSync(destination),
          target: selection.target,
          component,
          profile,
          path: row.destination,
        })
      } else if (iosFrameworkBinary != null) {
        validateFfmpegFrameworkBytes({
          bytes: readFileSync(destination),
          target: iosFrameworkBinary[2] === 'ios-arm64'
            ? 'ios-arm64'
            : 'ios-simulator-universal',
          component: iosFrameworkBinary[1],
          profile,
          path: row.destination,
        })
      }
    }
  }

  const opened = new Map()
  for (const selection of receipt.selections) {
    const { pack, manifest } = openPack(selection)
    if (manifest.profile !== profile.profile || manifest.target !== selection.target)
      throw new Error(`FFmpeg selected pack target/profile mismatch: ${selection.target}`)
    const args = selection.kind === 'ios-xcframeworks'
      ? [join(repo, 'scripts', 'verify-ffmpeg-ios-xcframeworks.mjs'), '--pack', pack]
      : [join(repo, 'scripts', 'verify-ffmpeg-codec-pack.mjs'), '--pack', pack]
    if (requireFull) args.push('--require-full')
    else if (selection.kind === 'ios-xcframeworks') args.push('--proof-staging')
    execFileSync(process.execPath, args, {
      stdio: 'inherit',
      env: proofStaging ? { ...process.env, SINGZ_CODEC_TARGET_PROOF: '1' } : process.env,
    })
    let expectedSources
    if (selection.kind === 'ios-xcframeworks') {
      expectedSources = manifest.files
        .map((row) => row.path)
        .filter((path) => /^lib(?:avcodec|avformat|avutil|swresample)\.xcframework\//.test(path))
    } else if (selection.kind === 'android-shared-libraries') {
      expectedSources = Object.values(manifest.runtimeLibraries)
    } else {
      throw new Error(`Unknown FFmpeg product selection kind: ${selection.kind}`)
    }
    verifyRows(selection, manifest, expectedSources)
    if (selection.kind === 'ios-xcframeworks') {
      assertExactSelectionTree({
        root: join(dependency, 'common', 'cpp', 'audioapi', 'external', 'ffmpeg_ios'),
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
    opened.set(selection.pack, { pack, manifest })
  }

  if (process.argv.includes('--verify-ios-compliance')) {
    const complianceReceipt = join(
      repo, 'mobile', 'ios', 'SingzCore', 'compliance', 'singz-ffmpeg-selection.json',
    )
    if (!existsSync(complianceReceipt) ||
        sha256(complianceReceipt) !== sha256(selectionReceiptPath)) {
      throw new Error('SingzCore iOS compliance receipt is missing or stale after codec selection')
    }
  }

  const headerSource = receipt.headers
  const openedHeaders = opened.get(headerSource?.pack) || openPack(headerSource || {})
  if (headerSource?.packManifestSha256 !==
      sha256(join(openedHeaders.pack, 'manifest.json')))
    throw new Error('Selected FFmpeg headers are not bound to their source manifest')
  const expectedHeaders = openedHeaders.manifest.files
    .map((row) => row.path)
    .filter((path) => path.startsWith('include/'))
  verifyRows(headerSource, openedHeaders.manifest, expectedHeaders)
  assertExactSelectionTree({
    root: join(dependency, 'common', 'cpp', 'audioapi', 'external', 'include_ffmpeg'),
    rows: headerSource.files,
    destinationPrefix: 'common/cpp/audioapi/external/include_ffmpeg',
    label: 'Selected FFmpeg headers',
  })

  const headers = join(dependency, 'common/cpp/audioapi/external/include_ffmpeg')
  for (const [relative, expected] of [
    ['libavcodec/version_major.h', /LIBAVCODEC_VERSION_MAJOR\s+62\b/],
    ['libavformat/version_major.h', /LIBAVFORMAT_VERSION_MAJOR\s+62\b/],
    ['libavutil/version.h', /LIBAVUTIL_VERSION_MAJOR\s+60\b/],
    ['libswresample/version_major.h', /LIBSWRESAMPLE_VERSION_MAJOR\s+6\b/],
  ]) {
    if (!expected.test(readFileSync(join(headers, relative), 'utf8')))
      throw new Error(`Selected FFmpeg header ABI changed: ${relative}`)
  }
  console.log(
    `FFmpeg product runtime verified: ${receipt.selections.map((row) => row.target).join(', ')}` +
      (requireFull ? ' + target fixture evidence' : ''),
  )
  process.exit(0)
}

if ((requireIos || requiredAndroidAbis.length > 0 || proofStaging) && strict) {
  throw new Error('Required FFmpeg product selection receipt is missing')
}
if (process.argv.includes('--verify-ios-compliance')) {
  // No selection is installed, so the pod's compliance bundle must not carry
  // a receipt either; sync-singzcore.js regenerates that directory.
  const complianceReceipt = join(
    repo, 'mobile', 'ios', 'SingzCore', 'compliance', 'singz-ffmpeg-selection.json',
  )
  if (existsSync(complianceReceipt)) {
    throw new Error(
      'SingzCore iOS compliance receipt is stale: no product selection is installed; rerun sync-singzcore.js',
    )
  }
}

const entries = readFileSync(sumsPath, 'utf8').split(/\r?\n/)
  .filter((line) => line && !line.startsWith('#'))
  .map((line) => {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/)
    if (!match) throw new Error(`Malformed FFmpeg checksum row: ${line}`)
    return { expected: match[1], relative: match[2] }
  })
// Only the platforms this build ships are pinned here: an Android build on a
// Linux runner never carries RNAudioAPI's iOS frameworks, and an iOS install
// does not need every Android ABI. With no platform named, everything the
// dependency actually contains is checked.
// RNAudioAPI fetches its iOS prebuilts in its own podspec prepare_command, so
// on a fresh checkout the Podfile reaches this verifier before they exist.
// With nothing selected there is nothing of ours to verify there yet; a
// strict run still insists, and a partial download still fails below.
const iosPrebuiltPresent =
  existsSync(join(dependency, 'common', 'cpp', 'audioapi', 'external', 'ffmpeg_ios'))
const iosExpected = requireIos
  ? (iosPrebuiltPresent || strict)
  : (requiredAndroidAbis.length === 0 && iosPrebuiltPresent)
const androidExpected = requiredAndroidAbis.length > 0
  ? new Set(requiredAndroidAbis)
  : (requireIos ? new Set() : new Set(Object.keys(abiTargets)))
const relevant = entries.filter(({ relative }) => {
  const abi = relative.match(/^android\/src\/main\/jniLibs\/([^/]+)\//)?.[1]
  return abi ? androidExpected.has(abi) : iosExpected
})
if (relevant.length === 0) {
  if (strict) throw new Error('No pinned FFmpeg compatibility artifact applies to this build')
  console.log(
    'FFmpeg compatibility runtime: react-native-audio-api has not fetched its iOS prebuilts yet; ' +
    `nothing selected, native decode stays on base WAV/FLAC (SINGZ_FFMPEG_CODECS=${mode})`,
  )
  process.exit(0)
}
for (const { expected, relative } of relevant) {
  const artifact = join(dependency, relative)
  if (!existsSync(artifact)) throw new Error(`Missing pinned FFmpeg artifact: ${artifact}`)
  const bytes = readFileSync(artifact)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new Error(`FFmpeg checksum mismatch: ${relative}`)
  if (!isDynamicLibrary(bytes))
    throw new Error(`FFmpeg artifact is not an ELF ET_DYN or Mach-O MH_DYLIB: ${relative}`)
}

// rn-audio-libs is still needed by RNAudioAPI, but it is not the SingZ
// full-matrix runtime. Inspect its embedded FFmpeg configuration rather than
// interpreting four ABI-compatible libraries as proof of codec support.
const optionSet = (relative, option) => {
  const text = readFileSync(join(dependency, relative)).toString('latin1')
  const match = text.match(new RegExp(`--enable-${option}=(?:'([^']+)'|"([^"]+)"|([^\\s\\0]+))`))
  if (!match) return new Set()
  return new Set((match[1] || match[2] || match[3]).split(','))
}
const compatibilityDemuxers = optionSet(
  'android/src/main/jniLibs/arm64-v8a/libavformat.so', 'demuxer')
const compatibilityDecoders = optionSet(
  'android/src/main/jniLibs/arm64-v8a/libavcodec.so', 'decoder')
const compatibilityParsers = optionSet(
  'android/src/main/jniLibs/arm64-v8a/libavcodec.so', 'parser')
const missing = []
for (const name of profile.requiredDemuxers) {
  if (!compatibilityDemuxers.has(name)) missing.push(`demuxer:${name}`)
}
for (const name of profile.requiredDecoders) {
  if (!compatibilityDecoders.has(name)) missing.push(`decoder:${name}`)
}
for (const name of profile.requiredParsers) {
  if (!compatibilityParsers.has(name)) missing.push(`parser:${name}`)
}
if (missing.length === 0)
  throw new Error('Compatibility runtime unexpectedly matches the full SingZ profile; update provenance and promote it explicitly')
if (requireFullArgument && strict) {
  throw new Error(
    `react-native-audio-api supplies only the compatibility runtime; full Phase 4 matrix is missing ${missing.join(', ')}`,
  )
}

const headers = join(dependency, 'common/cpp/audioapi/external/include_ffmpeg')
const majors = [
  ['libavcodec/version_major.h', /LIBAVCODEC_VERSION_MAJOR\s+62\b/],
  ['libavformat/version_major.h', /LIBAVFORMAT_VERSION_MAJOR\s+62\b/],
  ['libavutil/version.h', /LIBAVUTIL_VERSION_MAJOR\s+60\b/],
  ['libswresample/version_major.h', /LIBSWRESAMPLE_VERSION_MAJOR\s+6\b/],
]
for (const [relative, expected] of majors) {
  const header = join(headers, relative)
  if (!expected.test(readFileSync(header, 'utf8'))) {
    throw new Error(`Pinned FFmpeg header ABI changed: ${relative}`)
  }
}
console.log(
  `FFmpeg compatibility runtime verified: ${relevant.length} dynamic binaries, pinned ABI and notices; ` +
  `native decode stays on base WAV/FLAC (SINGZ_FFMPEG_CODECS=${mode}; the full matrix is missing ${missing.join(', ')})`,
)
