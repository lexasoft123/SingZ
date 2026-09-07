import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const proofContract = 'singz-codec-target-proof-v1'
export const canonicalFixtureNames = Object.freeze([
  'tone.mp3',
  'tone.aac',
  'tone-aac.m4a',
  'tone-alac.m4a',
  'tone.ogg',
  'tone.opus',
  'tone.aiff',
  'tone.aifc',
  'audio-plus-video.m4a',
  'video-only.m4a',
  'unsupported-flac.ogg',
  'cancel-long.mp3',
])

export const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}

export const canonicalJson = (value) => JSON.stringify(canonicalize(value))
export const sha256Bytes = (value) => createHash('sha256').update(value).digest('hex')
export const sha256Text = (value) => sha256Bytes(Buffer.from(value, 'utf8'))
export const sha256File = (path) => sha256Bytes(readFileSync(path))

const isSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const exactJson = (actual, expected, label) => {
  if (canonicalJson(actual) !== canonicalJson(expected))
    throw new Error(`${label} does not match the canonical codec target proof contract`)
}
const requireFile = (path, label) => {
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error(`Missing ${label}: ${path}`)
  return path
}

export const loadProofContract = (root) => {
  const path = requireFile(
    join(resolve(root), 'tests', 'fixtures', 'codecs', 'target-contract.json'),
    'codec target proof contract',
  )
  const contract = JSON.parse(readFileSync(path, 'utf8'))
  if (contract.format !== 1 || contract.proofContract !== proofContract)
    throw new Error('Unsupported codec target proof contract')
  exactJson(contract.fixtures.map((row) => row.name), canonicalFixtureNames,
    'fixture name/order')
  if (!Array.isArray(contract.cases) || contract.cases.length !== 34 ||
      !Array.isArray(contract.decoded) || contract.decoded.length !== 8)
    throw new Error('Codec target proof contract has an incomplete case matrix')
  return { path, contract }
}

export const loadProofSourceEvidence = (root) => {
  const absoluteRoot = resolve(root)
  const { path: contractPath, contract } = loadProofContract(absoluteRoot)
  const paths = {
    cpp: requireFile(join(absoluteRoot, 'tests', 'fixtures', 'codecs', 'target',
      'target_codec_proof.cpp'), 'codec target proof implementation'),
    header: requireFile(join(absoluteRoot, 'tests', 'fixtures', 'codecs', 'target',
      'target_codec_proof.h'), 'codec target proof header'),
    generator: requireFile(join(absoluteRoot, 'tests', 'fixtures', 'codecs',
      'generate.sh'), 'codec fixture generator'),
    contract: contractPath,
  }
  const sourceHashes = Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, sha256File(path)]),
  )
  const sourceStamp = sha256Text(
    `${sourceHashes.cpp}:${sourceHashes.header}:${sourceHashes.generator}:${sourceHashes.contract}`,
  )
  const platformPaths = {
    android: {
      jni: join(absoluteRoot, 'mobile', 'native', 'bindings', 'android',
        'codec_target_proof_jni.cpp'),
      instrumentation: join(absoluteRoot, 'mobile', 'android', 'app', 'src',
        'androidTest', 'java', 'com', 'singzplayer',
        'CodecTargetProofInstrumentedTest.kt'),
      pullDriver: join(absoluteRoot, 'mobile', 'scripts',
        'pull-codec-target-proof-android.mjs'),
    },
    ios: {
      bridgeHeader: join(absoluteRoot, 'mobile', 'ios', 'FolderAccess',
        'NativeCodecTargetProof.h'),
      bridge: join(absoluteRoot, 'mobile', 'ios', 'FolderAccess',
        'NativeCodecTargetProof.mm'),
      runtimeModule: join(absoluteRoot, 'mobile', 'ios', 'FolderAccess',
        'NativeAudioRuntimeBridge.mm'),
      appHook: join(absoluteRoot, 'mobile', 'App.tsx'),
      prepare: join(absoluteRoot, 'mobile', 'scripts',
        'prepare-codec-target-proof.mjs'),
      driver: join(absoluteRoot, 'mobile', 'tests', 'codec-target-ios.cjs'),
    },
  }
  const platformSourceHashes = Object.fromEntries(
    Object.entries(platformPaths).map(([platform, rows]) => [platform,
      Object.fromEntries(Object.entries(rows).map(([name, path]) =>
        [name, sha256File(requireFile(path, `${platform} codec proof source ${name}`))]))]),
  )
  const platformSourceStamps = Object.fromEntries(
    Object.entries(platformSourceHashes).map(([platform, rows]) => [platform,
      sha256Text(Object.keys(rows).sort().map((name) => `${name}:${rows[name]}`).join(':'))]),
  )
  const buildStamps = Object.fromEntries(
    Object.entries(platformSourceStamps).map(([platform, stamp]) =>
      [platform, sha256Text(`${sourceStamp}:${stamp}`)]),
  )
  const fixtureDirectory = join(absoluteRoot, 'tests', 'fixtures', 'codecs', 'data')
  const fixtures = contract.fixtures.map((expected) => {
    const path = requireFile(join(fixtureDirectory, expected.name),
      `canonical codec fixture ${expected.name}`)
    const actual = { name: expected.name, bytes: statSync(path).size, sha256: sha256File(path) }
    exactJson(actual, expected, `canonical fixture ${expected.name}`)
    return actual
  })
  return {
    proofContract,
    sourceStamp,
    sourceHashes,
    platformSourceHashes,
    platformSourceStamps,
    buildStamps,
    fixtureGeneratorSha256: sourceHashes.generator,
    fixtures,
    contract,
  }
}

const normalizedNativeOutput = (native, source) => ({
  format: native.format,
  execution: native.execution,
  result: native.result,
  proofContract: native.proofContract,
  proofSourceStamp: native.proofSourceStamp,
  platformSourceStamp: native.platformSourceStamp,
  proofBuildStamp: native.proofBuildStamp,
  capabilityTag: native.capabilityTag,
  capabilityMask: native.capabilityMask,
  dynamicFfmpeg: native.dynamicFfmpeg,
  completeProductMatrix: native.completeProductMatrix,
  runtimeLicense: native.runtimeLicense,
  fixtures: native.fixtures,
  cases: native.cases,
})

const expectedNativeOutput = (source, capabilityMask, target) => {
  const platform = targetPlatform(target)
  const decoded = new Map(source.contract.decoded.map((row) => [row.name, row]))
  return {
    format: 1,
    execution: 'actual-packaged-zcore-runtime',
    result: 'full dynamic matrix ok',
    proofContract,
    proofSourceStamp: source.sourceStamp,
    platformSourceStamp: source.platformSourceStamps[platform],
    proofBuildStamp: source.buildStamps[platform],
    capabilityTag: 'singz-prepared-audio-fd-ffmpeg-full-matrix-v3',
    capabilityMask,
    dynamicFfmpeg: true,
    completeProductMatrix: true,
    runtimeLicense: 'LGPL version 2.1 or later',
    fixtures: canonicalFixtureNames,
    cases: source.contract.cases.map((row) => {
      const dimensions = decoded.get(row.name)
      return dimensions == null ? row : { ...row, ...dimensions }
    }),
  }
}

const targetPlatform = (target) => target.startsWith('android-')
  ? 'android'
  : target.startsWith('ios-')
    ? 'ios'
    : null
const targetArchitecture = (target) => ({
  'android-arm64-v8a': 'arm64-v8a',
  'android-armeabi-v7a': 'armeabi-v7a',
  'android-x86': 'x86',
  'android-x86_64': 'x86_64',
  'ios-arm64': 'arm64',
  'ios-simulator-arm64': 'arm64',
  'ios-simulator-x64': 'x86_64',
})[target] ?? null

const readPack = (pack, { sourceManifestBytes, sourceManifestPath } = {}) => {
  const absolute = resolve(pack)
  if (sourceManifestBytes != null && sourceManifestPath != null)
    throw new Error('Pass sourceManifestBytes or sourceManifestPath, not both')
  const currentManifestPath = requireFile(join(absolute, 'manifest.json'),
    'codec pack manifest')
  const currentManifestBytes = readFileSync(currentManifestPath)
  const manifestPath = sourceManifestPath == null
    ? currentManifestPath
    : requireFile(resolve(sourceManifestPath), 'executed source pack manifest')
  const manifestBytes = sourceManifestBytes == null
    ? readFileSync(manifestPath)
    : Buffer.isBuffer(sourceManifestBytes)
      ? sourceManifestBytes
      : Buffer.from(sourceManifestBytes)
  return {
    path: absolute,
    manifestPath,
    manifestSha256: sha256Bytes(manifestBytes),
    manifest: JSON.parse(manifestBytes.toString('utf8')),
    currentManifestPath,
    currentManifestSha256: sha256Bytes(currentManifestBytes),
    currentManifest: JSON.parse(currentManifestBytes.toString('utf8')),
  }
}

const validateRuntimeRows = (rows) => {
  if (!Array.isArray(rows) || rows.length !== 4)
    throw new Error('Target evidence must hash exactly four loaded FFmpeg runtimes')
  const components = ['avcodec', 'avformat', 'avutil', 'swresample']
  exactJson(rows.map((row) => row?.component).sort(), [...components].sort(),
    'loaded FFmpeg component set')
  for (const row of rows) {
    if (typeof row.path !== 'string' || row.path.length === 0 ||
        !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || !isSha256(row.sha256))
      throw new Error(`Malformed target runtime evidence: ${JSON.stringify(row)}`)
  }
}

const validateBinary = (binary) => {
  if (typeof binary?.id !== 'string' || binary.id.length < 5 || binary.id.length > 512 ||
      typeof binary.path !== 'string' || binary.path.length === 0 ||
      !Number.isSafeInteger(binary.bytes) || binary.bytes <= 0 || !isSha256(binary.sha256))
    throw new Error('Target evidence has no exact binary/build identity')
}

const validateConfiguration = (configuration, profile, manifest) => {
  if (typeof configuration !== 'string' || configuration.length === 0 ||
      configuration.length > 32768)
    throw new Error('Target did not execute against a bounded FFmpeg configuration')
  for (const forbidden of profile.forbiddenConfigureFlags) {
    if (configuration.includes(forbidden))
      throw new Error(`Target FFmpeg configuration contains ${forbidden}`)
  }
  const tokens = configuration.split(/\s+/).map((token) =>
    token.replace(/^(--[^=]+)=['"](.+)['"]$/, '$1=$2'))
  for (const required of [
    '--disable-everything', '--disable-static', '--enable-shared', '--disable-network',
    `--enable-demuxer=${profile.requiredDemuxers.join(',')}`,
    `--enable-decoder=${profile.requiredDecoders.join(',')}`,
    `--enable-parser=${profile.requiredParsers.join(',')}`,
  ]) {
    if (!tokens.includes(required))
      throw new Error(`Target FFmpeg configuration is missing ${required}`)
  }
  if (typeof manifest.configuration !== 'string' ||
      sha256Text(configuration) !== sha256Text(manifest.configuration))
    throw new Error('Executed target configuration is not bound to the source pack')
}

const validateSelection = ({ root, target, packInfo, selectionEvidence }) => {
  if (selectionEvidence == null || typeof selectionEvidence.json !== 'string' ||
      !isSha256(selectionEvidence.sha256) ||
      sha256Text(selectionEvidence.json) !== selectionEvidence.sha256)
    throw new Error('Target did not hash its packaged FFmpeg selection receipt')
  const selection = JSON.parse(selectionEvidence.json)
  if (selection.format !== 1 || selection.mode !== 'target-proof-staging' ||
      !Array.isArray(selection.selections))
    throw new Error('Packaged FFmpeg selection receipt is malformed')
  if (target.startsWith('android-')) {
    const selected = selection.selections.find((row) => row.target === target)
    if (selected?.packManifestSha256 !== packInfo.manifestSha256)
      throw new Error(`Packaged selection is not bound to ${target}`)
    return {
      sha256: selectionEvidence.sha256,
      mode: selection.mode,
      selectedTarget: target,
      selectedManifestSha256: packInfo.manifestSha256,
    }
  }
  const selected = selection.selections.find((row) => row.target === 'ios-xcframeworks')
  if (selected == null || typeof selected.pack !== 'string' ||
      !isSha256(selected.packManifestSha256))
    throw new Error('Packaged iOS selection has no XCFramework manifest binding')
  const xcPack = resolve(root, selected.pack)
  const nested = relative(resolve(root, 'vendor', 'ffmpeg-codec'), xcPack)
  if (nested.startsWith('..') || nested === '' || resolve(xcPack) !== xcPack)
    throw new Error('Packaged iOS selection escapes the FFmpeg pack root')
  const xcManifestPath = requireFile(join(xcPack, 'manifest.json'),
    'selected iOS XCFramework manifest')
  if (sha256File(xcManifestPath) !== selected.packManifestSha256)
    throw new Error('Selected iOS XCFramework manifest changed after packaging')
  const xcManifest = JSON.parse(readFileSync(xcManifestPath, 'utf8'))
  if (xcManifest.mode !== 'target-proof-staging')
    throw new Error('Selected iOS XCFramework was not composed for target proof staging')
  if (xcManifest.format !== 2 ||
      xcManifest.packaging?.format !== 'dynamic-framework-xcframework-v2' ||
      xcManifest.packaging?.dynamic !== true ||
      xcManifest.packaging?.headers?.format !== 'canonical-namespaced-include-tree-v1' ||
      xcManifest.packaging?.headers?.root !== 'include' ||
      xcManifest.packaging?.headers?.frameworkSurface !== 'runtime-marker-only-v1')
    throw new Error('Selected iOS XCFramework is not the verified dynamic-framework package')
  if (xcManifest.slices?.[target]?.packManifestSha256 !== packInfo.manifestSha256)
    throw new Error(`Selected iOS XCFramework is not bound to source slice ${target}`)
  return {
    sha256: selectionEvidence.sha256,
    mode: selection.mode,
    selectedTarget: 'ios-xcframeworks',
    selectedManifestSha256: selected.packManifestSha256,
  }
}

export const createTargetProofReceipt = ({ evidence, profile, target, pack, root }) => {
  const source = loadProofSourceEvidence(root)
  const packInfo = readPack(pack)
  if (packInfo.manifest.target !== target || packInfo.manifest.profile !== profile.profile)
    throw new Error('Target proof pack/target/profile mismatch')
  const platform = targetPlatform(target)
  const architecture = targetArchitecture(target)
  if (platform == null || evidence?.format !== 1 ||
      evidence.executionMode !== 'actual-packaged-runtime' ||
      evidence.platform !== platform || evidence.target !== target ||
      evidence.architecture !== architecture ||
      evidence.result !== 'full dynamic matrix ok')
    throw new Error('Evidence was not executed by the requested packaged mobile target')
  if (typeof evidence.osVersion !== 'string' || evidence.osVersion.length === 0)
    throw new Error('Target evidence has no OS identity')

  const nativeOutput = JSON.parse(evidence.nativeOutput)
  const numericMask = Number.parseInt(profile.capabilityMask, 16)
  const normalized = normalizedNativeOutput(nativeOutput, source)
  const expected = expectedNativeOutput(source, numericMask, target)
  exactJson(normalized, expected, 'executed native output')
  if (evidence.outputSha256 !== sha256Text(evidence.nativeOutput))
    throw new Error('Target output hash does not bind its canonical native JSON')
  validateConfiguration(nativeOutput.runtimeConfiguration, profile, packInfo.manifest)
  const configurationSha256 = sha256Text(nativeOutput.runtimeConfiguration)
  if (evidence.configurationSha256 !== configurationSha256)
    throw new Error('Target configuration hash does not bind executed configuration')

  exactJson(evidence.fixtures, source.fixtures, 'target fixture bytes/order')
  validateRuntimeRows(evidence.runtimeLibraries)
  validateBinary(evidence.binary)
  const selection = validateSelection({
    root: resolve(root), target, packInfo, selectionEvidence: evidence.selectionReceipt,
  })
  const runtimeLibraries = Object.fromEntries(
    evidence.runtimeLibraries.map((row) => [row.component, {
      path: row.path,
      bytes: row.bytes,
      sha256: row.sha256,
    }]),
  )
  if (platform === 'android') {
    for (const [component, row] of Object.entries(runtimeLibraries)) {
      const sourcePath = packInfo.manifest.runtimeLibraries?.[component]
      const absolute = sourcePath == null ? null : join(packInfo.path, sourcePath)
      if (absolute == null || !existsSync(absolute) ||
          statSync(absolute).size !== row.bytes || sha256File(absolute) !== row.sha256)
        throw new Error(`Executed Android ${component} bytes differ from source pack`)
    }
  }

  return {
    format: 2,
    profile: profile.profile,
    target,
    capabilityMask: profile.capabilityMask,
    result: 'full dynamic matrix ok',
    proofContract,
    proofSourceStamp: source.sourceStamp,
    platformSourceStamp: source.platformSourceStamps[platform],
    proofBuildStamp: source.buildStamps[platform],
    fixtureGeneratorSha256: source.fixtureGeneratorSha256,
    testSourceSha256: {
      common: source.sourceHashes,
      platform: source.platformSourceHashes[platform],
    },
    sourcePackManifestSha256: packInfo.manifestSha256,
    fixtures: source.fixtures,
    expectedOutputSha256: sha256Text(canonicalJson(expected)),
    outputSha256: evidence.outputSha256,
    nativeOutput: evidence.nativeOutput,
    execution: {
      mode: 'actual-packaged-runtime',
      platform,
      architecture,
      osVersion: evidence.osVersion,
      binary: evidence.binary,
      configurationSha256,
      selectionReceipt: selection,
      runtimeLibraries,
    },
  }
}

export const validateTargetProofReceipt = ({
  receipt,
  profile,
  target,
  pack,
  selection,
  root,
  sourceManifestBytes,
  sourceManifestPath,
}) => {
  const absoluteRoot = resolve(root ?? join(resolve(pack), '..', '..', '..'))
  const source = loadProofSourceEvidence(absoluteRoot)
  const packInfo = readPack(pack, { sourceManifestBytes, sourceManifestPath })
  if (packInfo.manifest.target !== target || packInfo.manifest.profile !== profile.profile ||
      packInfo.currentManifest.target !== target ||
      packInfo.currentManifest.profile !== profile.profile)
    throw new Error('Target proof source/final pack target or profile mismatch')
  if (receipt?.format !== 2 || receipt.profile !== profile.profile ||
      receipt.target !== target || receipt.capabilityMask !== profile.capabilityMask ||
      receipt.result !== 'full dynamic matrix ok' ||
      receipt.proofContract !== proofContract ||
      receipt.proofSourceStamp !== source.sourceStamp ||
      receipt.fixtureGeneratorSha256 !== source.fixtureGeneratorSha256 ||
      receipt.sourcePackManifestSha256 !== packInfo.manifestSha256)
    throw new Error('Target proof receipt does not bind this source/profile/pack')
  const platform = targetPlatform(target)
  if (receipt.platformSourceStamp !== source.platformSourceStamps[platform] ||
      receipt.proofBuildStamp !== source.buildStamps[platform])
    throw new Error('Target proof receipt platform/build stamp changed')
  exactJson(receipt.testSourceSha256, {
    common: source.sourceHashes,
    platform: source.platformSourceHashes[platform],
  }, 'target proof source hashes')
  exactJson(receipt.fixtures, source.fixtures, 'target proof fixture bytes/order')

  const nativeOutput = JSON.parse(receipt.nativeOutput)
  const expected = expectedNativeOutput(
    source, Number.parseInt(profile.capabilityMask, 16), target)
  exactJson(normalizedNativeOutput(nativeOutput, source), expected,
    'receipt native output')
  if (receipt.expectedOutputSha256 !== sha256Text(canonicalJson(expected)) ||
      receipt.outputSha256 !== sha256Text(receipt.nativeOutput))
    throw new Error('Target proof receipt output hashes do not match exact expected output')
  validateConfiguration(nativeOutput.runtimeConfiguration, profile, packInfo.manifest)
  if (receipt.execution?.mode !== 'actual-packaged-runtime' ||
      receipt.execution.platform !== targetPlatform(target) ||
      receipt.execution.architecture !== targetArchitecture(target) ||
      receipt.execution.configurationSha256 !== sha256Text(nativeOutput.runtimeConfiguration))
    throw new Error('Target proof receipt has no actual packaged-runtime execution identity')
  validateBinary(receipt.execution.binary)
  const rows = Object.entries(receipt.execution.runtimeLibraries ?? {})
    .map(([component, row]) => ({ component, ...row }))
  validateRuntimeRows(rows)
  if (selection != null && receipt.execution.selectionReceipt?.sha256 !== selection.sha256)
    throw new Error('Target proof receipt does not bind the required packaged selection')
  if (!isSha256(receipt.execution.selectionReceipt?.sha256) ||
      receipt.execution.selectionReceipt?.mode !== 'target-proof-staging' ||
      !isSha256(receipt.execution.selectionReceipt?.selectedManifestSha256))
    throw new Error('Target proof receipt selection binding is malformed')
  if (target.startsWith('android-')) {
    for (const [component, row] of rows.map((item) => [item.component, item])) {
      const sourcePath = packInfo.manifest.runtimeLibraries?.[component]
      const absolute = sourcePath == null ? null : join(packInfo.path, sourcePath)
      if (absolute == null || !existsSync(absolute) ||
          statSync(absolute).size !== row.bytes || sha256File(absolute) !== row.sha256)
        throw new Error(`Receipt Android ${component} bytes differ from source pack`)
    }
  }
  return receipt
}
