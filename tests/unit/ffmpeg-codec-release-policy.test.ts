import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertHostProofFixtureSet,
  loadHostProofSourceEvidence,
} from '../../scripts/codec-host-proof-contract.mjs'
import { canonicalFixtureNames } from '../../scripts/codec-target-proof-contract.mjs'
import {
  ffmpegFrameworkHeaderContents,
  ffmpegFrameworkHeaderName,
  ffmpegFrameworkModuleMap,
  validateFfmpegFrameworkBytes,
  validateFfmpegRuntimeBytes,
} from '../../scripts/ffmpeg-runtime-binary.mjs'

const require = createRequire(import.meta.url)
const { nativeBuildLockPath } = require('../../scripts/native-build-lock.cjs') as {
  nativeBuildLockPath(root: string): string
}
const root = process.cwd()
// Windows runners check out with CRLF (Git for Windows' autocrlf), and the
// multi-line `toContain` below compares against '\n'-joined text — the
// 2026-09-07 scheduled desktop build failed on exactly that, Windows leg
// only. Normalize on read so the assertions are about content, not line ends.
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8').replace(/\r\n/g, '\n')
const profile = JSON.parse(read('third_party/ffmpeg-codec/profile.json'))

const machDylibCommand = (command: number, name: string): Buffer => {
  const nameBytes = Buffer.from(`${name}\0`, 'utf8')
  const size = (24 + nameBytes.length + 7) & ~7
  const bytes = Buffer.alloc(size)
  bytes.writeUInt32LE(command, 0)
  bytes.writeUInt32LE(size, 4)
  bytes.writeUInt32LE(24, 8)
  nameBytes.copy(bytes, 24)
  return bytes
}

const simulatorMachDylib = (installName: string, dependencies: string[]): Buffer => {
  const buildVersion = Buffer.alloc(24)
  buildVersion.writeUInt32LE(0x32, 0)
  buildVersion.writeUInt32LE(24, 4)
  buildVersion.writeUInt32LE(7, 8)
  const commands = [
    buildVersion,
    machDylibCommand(0x0d, installName),
    ...dependencies.map((dependency) => machDylibCommand(0x0c, dependency)),
  ]
  const bytes = Buffer.alloc(32 + commands.reduce((sum, row) => sum + row.length, 0))
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(0x0100000c, 4)
  bytes.writeUInt32LE(6, 12)
  bytes.writeUInt32LE(commands.length, 16)
  bytes.writeUInt32LE(bytes.length - 32, 20)
  let offset = 32
  for (const command of commands) {
    command.copy(bytes, offset)
    offset += command.length
  }
  return bytes
}

describe('FFmpeg release policy', () => {
  it('keeps proof staging explicit and release selection full/equivalent to the shipping ABI set', () => {
    const selector = read('mobile/scripts/select-ffmpeg-codec-runtime.mjs')
    const verifier = read('mobile/scripts/verify-ffmpeg-codec-runtime.mjs')
    const selectionPolicy = read('mobile/scripts/ffmpeg-codec-selection-policy.mjs')
    const gradle = read('mobile/android/app/build.gradle')

    for (const source of [selector, verifier]) {
      expect(source).toContain("process.env.SINGZ_CODEC_TARGET_PROOF !== '1'")
    }
    for (const source of [selector, selectionPolicy])
      expect(source).toContain("'target-proof-staging'")
    expect(selector).toContain("'release-proven'")
    expect(selectionPolicy).toContain("'release-proven'")
    expect(selector).toContain("if (verifyFull) verifyArgs.push('--require-full')")
    expect(gradle).toContain('abiFilters(*singzShippingCodecAbis)')
    expect(gradle).toContain('"--require-android-set", singzShippingCodecAbis.join(\',\')')
    expect(gradle).toContain('Codec target-proof staging is configuration-only')
  })

  it('keeps the extended codec runtime opt-in behind SINGZ_FFMPEG_CODECS on every platform', () => {
    // An ordinary build (and CI, which carries no product pack) must compile
    // the base WAV/FLAC decoder rather than fail closed; only a fully proven
    // pack, or the explicit proof harness, turns the FFmpeg decoder on.
    const policy = read('mobile/scripts/ffmpeg-codec-selection-policy.mjs')
    const selector = read('mobile/scripts/select-ffmpeg-codec-runtime.mjs')
    const verifier = read('mobile/scripts/verify-ffmpeg-codec-runtime.mjs')
    const androidCmake = read('mobile/android/app/src/main/cpp/CMakeLists.txt')
    const podspec = read('mobile/ios/SingzCore/SingzCore.podspec')
    const builder = read('scripts/build-capture-addon.cjs')
    const artifact = read('scripts/capture-artifact.cjs')

    expect(policy).toContain("export const codecRuntimeMode")
    expect(policy).toContain("export const packHasFullMatrixEvidence")
    for (const source of [selector, verifier]) {
      expect(source).toContain('codecRuntimeMode()')
      expect(source).toContain("const strict = mode === 'required' || proofStaging")
    }
    expect(selector).toContain('packHasFullMatrixEvidence(manifest)')
    expect(selector).toContain('restoreCompatibilityRuntime()')
    expect(verifier).toContain('if (requireFullArgument && strict)')
    expect(androidCmake).toContain('singz-ffmpeg-selection.json')
    expect(androidCmake).toContain('string(JSON SINGZ_FFMPEG_SELECTION_MODE')
    expect(androidCmake).toContain('set(SINGZ_ENABLE_FFMPEG_CODECS ${SINGZ_FFMPEG_SELECTED} CACHE BOOL "" FORCE)')
    expect(androidCmake).not.toContain('set(SINGZ_ENABLE_FFMPEG_CODECS ON CACHE BOOL "" FORCE)')
    expect(androidCmake).toContain('if(SINGZ_ENABLE_FFMPEG_CODECS)\n    add_custom_command(TARGET singzcore POST_BUILD')
    expect(podspec).toContain("ffmpeg_definitions = ' SINGZ_ZCORE_FFMPEG=1'")
    expect(podspec).toContain('"$(inherited) HAVE_CONFIG_H=1#{ffmpeg_definitions}"')
    expect(podspec).not.toContain("HAVE_CONFIG_H=1 SINGZ_ZCORE_FFMPEG=1'")
    expect(builder).toContain("process.env.SINGZ_FFMPEG_CODECS || 'auto'")
    expect(builder).toContain("manifest.fixtureEvidence?.fullMatrix !== true")
    expect(builder).toContain("'-DSINGZ_ENABLE_FFMPEG_CODECS=OFF'")
    expect(builder).toContain('Base capture addon unexpectedly imports an FFmpeg library')
    expect(builder).toContain('expectedCodecPackManifestSha256: codecPack ? codecPack.manifestSha256 : null')
    expect(artifact).toContain('expectedCodecPackManifestSha256 === null && manifest.codecRuntime !== undefined')
  })

  it('re-materializes and verifies iOS compliance after product selection', () => {
    const podfile = read('mobile/ios/Podfile')
    const select = podfile.indexOf('select-ffmpeg-codec-runtime.mjs')
    const sync = podfile.indexOf('sync-singzcore.js')
    const verify = podfile.indexOf('verify-ffmpeg-codec-runtime.mjs')
    expect(select).toBeGreaterThan(0)
    expect(sync).toBeGreaterThan(select)
    expect(verify).toBeGreaterThan(sync)
    expect(podfile).toContain("'--require-ios', '--verify-ios-compliance'")
    expect(read('mobile/ios/SingzCore/SingzCore.podspec')).toContain(
      'Codec target-proof staging cannot be packaged in a Release IPA.',
    )
  })

  it('packages iOS FFmpeg as strict dynamic frameworks inside XCFrameworks', () => {
    const composer = read('scripts/compose-ffmpeg-ios-xcframeworks.mjs')
    const verifier = read('scripts/verify-ffmpeg-ios-xcframeworks.mjs')
    expect(composer).toContain("'-framework', deviceFramework")
    expect(composer).toContain("'-framework', simulatorFramework")
    expect(composer).not.toContain("'-library'")
    expect(composer).toContain('format: ffmpegFrameworkPackagingFormat')
    expect(composer).toContain('ffmpegFrameworkHeaderContents(component)')
    expect(composer).not.toContain('cpSync(join(headers, name)')
    expect(composer).toContain("execFileSync('install_name_tool'")
    expect(verifier).toContain('manifest.format !== 2')
    expect(verifier).toContain('validateFfmpegFrameworkBytes')
    expect(verifier).toContain('contains a raw dylib instead of a framework executable')
    expect(verifier).toContain('exposes forbidden flat FFmpeg headers')
    expect(verifier).toContain("allowedRootFiles: ['manifest.json']")
    expect(verifier).toContain('assertExactManifestTree')
    expect(ffmpegFrameworkHeaderName('avutil')).toBe('SingzFfmpegAvutilRuntime.h')
    expect(ffmpegFrameworkHeaderContents('avutil')).not.toContain('#include')
    expect(ffmpegFrameworkModuleMap('avutil')).toContain(
      'umbrella header "SingzFfmpegAvutilRuntime.h"',
    )
    expect(ffmpegFrameworkModuleMap('avutil')).not.toContain('umbrella "."')

    const good = simulatorMachDylib('@rpath/libavcodec.framework/libavcodec', [
      '@rpath/libswresample.framework/libswresample',
      '@rpath/libavutil.framework/libavutil',
      '/usr/lib/libSystem.B.dylib',
    ])
    expect(() => validateFfmpegFrameworkBytes({
      bytes: good,
      target: 'ios-simulator-arm64',
      component: 'avcodec',
      profile,
    })).not.toThrow()

    const stale = simulatorMachDylib('@rpath/libavcodec.62.dylib', [
      '@rpath/libswresample.6.dylib',
      '@rpath/libavutil.60.dylib',
    ])
    expect(() => validateFfmpegFrameworkBytes({
      bytes: stale,
      target: 'ios-simulator-arm64',
      component: 'avcodec',
      profile,
    })).toThrow('wrong Mach-O install name')

    const widened = simulatorMachDylib('@rpath/libavcodec.framework/libavcodec', [
      '@rpath/libswresample.framework/libswresample',
      '@rpath/libavutil.framework/libavutil',
      '@rpath/unknown.framework/unknown',
    ])
    expect(() => validateFfmpegFrameworkBytes({
      bytes: widened,
      target: 'ios-simulator-arm64',
      component: 'avcodec',
      profile,
    })).toThrow('forbidden or missing @rpath dependencies')
  })

  it('identifies an exported tree with no git by its own root, so a field machine can build', () => {
    // The Windows laptop builds the addon from an unpacked `git archive` and
    // has no git at all; asking git for the common dir threw ENOENT there and
    // the build never started. Such a tree is its own identity.
    const root = mkdtempSync(join(tmpdir(), 'singz-no-git-'))
    try {
      const path = nativeBuildLockPath(root)
      expect(path).toContain('singz-native-build-')
      expect(path).not.toContain(root)
      expect(nativeBuildLockPath(root)).toBe(path)
      const other = mkdtempSync(join(tmpdir(), 'singz-no-git-'))
      try {
        expect(nativeBuildLockPath(other)).not.toBe(path)
      } finally {
        rmSync(other, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('serializes sibling checkouts on one repository identity and one compile edge', () => {
    expect(nativeBuildLockPath(root)).toBe(nativeBuildLockPath(join(root, 'zcore')))
    expect(nativeBuildLockPath(root)).not.toContain(root)
    expect(read('scripts/build-ffmpeg-codec-runtime.sh')).toContain('COMPILE_JOBS=1')
    expect(read('scripts/build-capture-addon.cjs')).toContain('Math.min(requested, 1)')
  })

  it('locks ordinary core builds globally and never scales them from CPU count', () => {
    for (const path of ['scripts/run-core-host-tests.sh', 'scripts/build-analyze-host.sh']) {
      const source = read(path)
      expect(source).toContain('with-native-build-lock.mjs')
      expect(source).toContain('assert-native-build-lock.cjs')
      expect(source).toContain('--parallel 4')
      expect(source).not.toContain('_NPROCESSORS_ONLN')
      expect(source).not.toContain('sysctl -n hw.ncpu')
    }
    expect(read('scripts/with-native-build-lock.mjs')).toContain(
      'console.error(`SingZ native build lock:',
    )
  })

  it('reads the PE machine from bytes rather than trusting a target label', () => {
    const pe = Buffer.alloc(128)
    pe.write('MZ', 0, 'ascii')
    pe.writeUInt32LE(0x40, 0x3c)
    pe.write('PE\0\0', 0x40, 'ascii')
    pe.writeUInt16LE(0x8664, 0x44)
    pe.writeUInt16LE(0x2000, 0x40 + 22)
    expect(() => validateFfmpegRuntimeBytes({
      bytes: pe,
      target: 'win32-x64',
      component: 'avcodec',
      profile,
      path: 'bin/avcodec-62.dll',
    })).not.toThrow()
    pe.writeUInt16LE(0x014c, 0x44)
    expect(() => validateFfmpegRuntimeBytes({
      bytes: pe,
      target: 'win32-x64',
      component: 'avcodec',
      profile,
      path: 'bin/avcodec-62.dll',
    })).toThrow('PE machine is not AMD64')
  })

  it('accounts for retained, scratch and replacement buffers at once', () => {
    const decoder = read('zcore/src/media/ffmpeg_decoder.cpp')
    expect(decoder).toContain('liveBeforeReplacement + replacement.capacity()')
    expect(decoder).toContain('std::vector<float> replacement(targetCapacity)')
    expect(decoder).toContain('const size_t doubled = oldCapacity * 2')
    expect(read('tests/native/codec_provisioning_tests.cpp')).toContain(
      'working-byte limit accounts for vector replacement overlap',
    )
  })

  it('binds host receipts to canonical fixtures, sources, build and exact output', () => {
    const proof = read('scripts/codec-host-proof-contract.mjs')
    expect(proof).toContain("hostProofContract = 'singz-codec-host-proof-v2'")
    expect(proof).toContain('canonicalFixtureNames')
    expect(proof).toContain('fixtureGeneratorSha256')
    expect(proof).toContain('testSourceSha256')
    expect(proof).toContain('proofBuildStamp')
    expect(proof).toContain('expectedOutputSha256')
    expect(proof).toContain('assertHostProofFixtureSet')
    expect(read('scripts/prove-ffmpeg-codec-runtime.mjs')).toContain(
      'run.stdout !== expectedOutput',
    )
    expect(read('scripts/prove-ffmpeg-codec-runtime.mjs')).toContain(
      'fixtureDirectory: fixtures, source',
    )
    expect(read('scripts/build-ffmpeg-codec-runtime.sh')).toContain(
      'proof_fixtures="$ROOT/tests/fixtures/codecs/data"',
    )
    expect(read('scripts/build-ffmpeg-codec-runtime.sh')).not.toContain(
      'bash "$ROOT/tests/fixtures/codecs/generate.sh" "$FIXTURES"',
    )
    expect(read('scripts/build-ffmpeg-codec-runtime.sh')).toContain(
      'promote-ffmpeg-host-proof.mjs',
    )
    const promotion = read('scripts/promote-ffmpeg-host-proof.mjs')
    expect(promotion).toContain('Source codec pack byte ledger is stale')
    expect(promotion).toContain('validateHostProofReceipt({')
    expect(promotion.indexOf('collectFiles(output)')).toBeLessThan(
      promotion.indexOf('validateHostProofReceipt({'),
    )
    expect(promotion.indexOf('validateHostProofReceipt({')).toBeLessThan(
      promotion.indexOf("'--pack', partial, '--require-full'"),
    )
  })

  it('rejects regenerated or changed bytes before host fixture execution', () => {
    const source = loadHostProofSourceEvidence(root)
    const canonical = resolve(root, 'tests/fixtures/codecs/data')
    expect(assertHostProofFixtureSet({ fixtureDirectory: canonical, source })).toEqual(source.fixtures)

    const changed = mkdtempSync(join(tmpdir(), 'singz-host-proof-fixtures-'))
    try {
      for (const name of canonicalFixtureNames)
        copyFileSync(join(canonical, name), join(changed, name))
      appendFileSync(join(changed, 'tone.ogg'), Buffer.from([0]))
      expect(() => assertHostProofFixtureSet({ fixtureDirectory: changed, source }))
        .toThrow('executed fixture bytes/order')
    } finally {
      rmSync(changed, { recursive: true, force: true })
    }
  })
})
