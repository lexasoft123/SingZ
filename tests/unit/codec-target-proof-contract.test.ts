import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalFixtureNames,
  canonicalJson,
  createTargetProofReceipt,
  loadProofSourceEvidence,
  proofContract,
  sha256File,
  sha256Text,
  validateTargetProofReceipt
} from '../../scripts/codec-target-proof-contract.mjs'

const root = resolve(process.cwd())
const profile = JSON.parse(
  readFileSync(join(root, 'third_party/ffmpeg-codec/profile.json'), 'utf8')
)
const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

const configuration = [
  '--disable-everything',
  '--disable-static',
  '--enable-shared',
  '--disable-network',
  `--enable-demuxer=${profile.requiredDemuxers.join(',')}`,
  `--enable-decoder=${profile.requiredDecoders.join(',')}`,
  `--enable-parser=${profile.requiredParsers.join(',')}`
].join(' ')

const makeEvidence = () => {
  const directory = mkdtempSync(join(tmpdir(), 'singz-codec-target-proof-'))
  temporary.push(directory)
  const pack = join(directory, 'vendor/ffmpeg-codec/android-arm64-v8a')
  mkdirSync(join(pack, 'lib'), { recursive: true })
  const runtimeLibraries: Record<string, string> = {}
  const runtimeRows: Array<{ component: string; path: string; bytes: number; sha256: string }> = []
  for (const component of ['avcodec', 'avformat', 'avutil', 'swresample']) {
    const relative = `lib/lib${component}.so`
    const path = join(pack, relative)
    writeFileSync(path, Buffer.from(`packaged-${component}-runtime`))
    runtimeLibraries[component] = relative
    runtimeRows.push({
      component,
      path: `/data/app/lib/${component}.so`,
      bytes: statSync(path).size,
      sha256: sha256File(path)
    })
  }
  const manifest = {
    format: 1,
    profile: profile.profile,
    target: 'android-arm64-v8a',
    configuration,
    runtimeLibraries
  }
  writeFileSync(join(pack, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const manifestSha256 = sha256File(join(pack, 'manifest.json'))
  const selectionJson = JSON.stringify({
    format: 1,
    mode: 'target-proof-staging',
    selections: [{
      target: 'android-arm64-v8a',
      packManifestSha256: manifestSha256
    }]
  })

  const source = loadProofSourceEvidence(root)
  const decoded = new Map(source.contract.decoded.map(
    (row: { name: string }) => [row.name, row]
  ))
  const native = {
    format: 1,
    execution: 'actual-packaged-zcore-runtime',
    result: 'full dynamic matrix ok',
    proofContract,
    proofSourceStamp: source.sourceStamp,
    platformSourceStamp: source.platformSourceStamps.android,
    proofBuildStamp: source.buildStamps.android,
    capabilityTag: 'singz-prepared-audio-fd-ffmpeg-full-matrix-v3',
    capabilityMask: Number.parseInt(profile.capabilityMask, 16),
    dynamicFfmpeg: true,
    completeProductMatrix: true,
    runtimeVersion: '8.0.1',
    runtimeLicense: 'LGPL version 2.1 or later',
    runtimeConfiguration: configuration,
    fixtures: canonicalFixtureNames,
    cases: source.contract.cases.map((row: { name: string; result: string }) => {
      const dimensions = decoded.get(row.name)
      return dimensions == null ? row : { ...row, ...dimensions }
    })
  }
  const nativeOutput = JSON.stringify(native)
  const evidence = {
    format: 1,
    executionMode: 'actual-packaged-runtime',
    platform: 'android',
    target: 'android-arm64-v8a',
    architecture: 'arm64-v8a',
    osVersion: 'test-os',
    result: 'full dynamic matrix ok',
    nativeOutput,
    outputSha256: sha256Text(nativeOutput),
    configurationSha256: sha256Text(configuration),
    runtimeLibraries: runtimeRows,
    binary: {
      id: 'com.lexasoft.singz:0.19.1:40:arm64-v8a',
      path: '/data/app/lib/libsingzcore.so',
      bytes: 123456,
      sha256: createHash('sha256').update('target-binary').digest('hex')
    },
    selectionReceipt: {
      path: 'third_party/ffmpeg/singz-ffmpeg-selection.json',
      bytes: Buffer.byteLength(selectionJson),
      sha256: sha256Text(selectionJson),
      json: selectionJson
    },
    fixtures: source.fixtures
  }
  return { pack, evidence }
}

describe('target-executed codec proof contract', () => {
  it('binds one receipt to exact source, generator, fixtures, output, runtime, selection and binary', () => {
    const { pack, evidence } = makeEvidence()
    const receipt = createTargetProofReceipt({
      evidence,
      profile,
      target: 'android-arm64-v8a',
      pack,
      root
    })
    expect(receipt).toMatchObject({
      format: 2,
      target: 'android-arm64-v8a',
      proofContract,
      result: 'full dynamic matrix ok',
      execution: {
        mode: 'actual-packaged-runtime',
        platform: 'android',
        architecture: 'arm64-v8a'
      }
    })
    expect(receipt.fixtures.map((row: { name: string }) => row.name)).toEqual(
      canonicalFixtureNames
    )
    expect(receipt.expectedOutputSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(validateTargetProofReceipt({
      receipt,
      profile,
      target: 'android-arm64-v8a',
      pack,
      root
    })).toBe(receipt)
  })

  it.each([
    ['source-inspected execution', (e: any) => { e.executionMode = 'configuration-inspected' }],
    ['wrong target fixture', (e: any) => { e.fixtures[0] = { ...e.fixtures[0], bytes: 1 } }],
    ['changed expected case', (e: any) => {
      const parsed = JSON.parse(e.nativeOutput)
      parsed.cases[0].result = 'rejected'
      e.nativeOutput = JSON.stringify(parsed)
      e.outputSha256 = sha256Text(e.nativeOutput)
    }],
    ['wrong build stamp', (e: any) => {
      const parsed = JSON.parse(e.nativeOutput)
      parsed.proofSourceStamp = '0'.repeat(64)
      e.nativeOutput = JSON.stringify(parsed)
      e.outputSha256 = sha256Text(e.nativeOutput)
    }],
    ['changed runtime byte', (e: any) => { e.runtimeLibraries[0].sha256 = '0'.repeat(64) }],
    ['unbound selection', (e: any) => {
      const parsed = JSON.parse(e.selectionReceipt.json)
      parsed.selections[0].packManifestSha256 = '0'.repeat(64)
      e.selectionReceipt.json = JSON.stringify(parsed)
      e.selectionReceipt.sha256 = sha256Text(e.selectionReceipt.json)
    }]
  ])('rejects %s instead of treating it as target execution', (_label, mutate) => {
    const { pack, evidence } = makeEvidence()
    mutate(evidence)
    expect(() => createTargetProofReceipt({
      evidence,
      profile,
      target: 'android-arm64-v8a',
      pack,
      root
    })).toThrow()
  })

  it('keeps target proof code and fixtures out of ordinary product packaging', () => {
    const gradle = readFileSync(join(root, 'mobile/android/app/build.gradle'), 'utf8')
    const cmake = readFileSync(
      join(root, 'mobile/android/app/src/main/cpp/CMakeLists.txt'), 'utf8'
    )
    const podspec = readFileSync(
      join(root, 'mobile/ios/FolderAccess/FolderAccess.podspec'), 'utf8'
    )
    const driver = readFileSync(join(root, 'mobile/tests/codec-target-ios.cjs'), 'utf8')
    expect(gradle).toContain("project.findProperty('singzCodecTargetProof') == 'true'")
    expect(gradle).toContain('android.sourceSets.androidTest.assets.srcDir')
    expect(cmake).toContain('option(SINGZ_CODEC_TARGET_PROOF')
    expect(podspec).toContain("ENV['SINGZ_CODEC_TARGET_PROOF'] == '1'")
    expect(driver).toContain('candidate.deviceName === deviceName')
    expect(driver).not.toMatch(/find\(.*webSocketDebuggerUrl/)
  })

  it('validates a promoted final pack against the preserved manifest that was executed', () => {
    const { pack, evidence } = makeEvidence()
    const sourceManifestBytes = readFileSync(join(pack, 'manifest.json'))
    const receipt = createTargetProofReceipt({
      evidence,
      profile,
      target: 'android-arm64-v8a',
      pack,
      root
    })
    const promoted = JSON.parse(sourceManifestBytes.toString('utf8'))
    promoted.fixtureEvidence = { fullMatrix: true, receiptSha256: '0'.repeat(64) }
    writeFileSync(join(pack, 'manifest.json'), `${JSON.stringify(promoted, null, 2)}\n`)
    expect(() => validateTargetProofReceipt({
      receipt,
      profile,
      target: 'android-arm64-v8a',
      pack,
      root
    })).toThrow(/source\/profile\/pack/)
    expect(validateTargetProofReceipt({
      receipt,
      profile,
      target: 'android-arm64-v8a',
      pack,
      root,
      sourceManifestBytes
    })).toBe(receipt)
  })

  it('uses canonical JSON independent of object insertion order', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}'
    )
  })
})
