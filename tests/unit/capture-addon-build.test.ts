import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { captureSourceFingerprint } from '../../src/main/capture'
import { machCanonicalSha256 as runtimeMachCanonicalSha256 } from '../../src/main/mach-canonical'

const require = createRequire(import.meta.url)
const artifacts = require('../../scripts/capture-artifact.cjs') as {
  assertHostCanBuildTarget(target: string, hostPlatform: string): void
  assertSourceFingerprintUnchanged(expected: string, actual: string, phase: string): void
  requestedCaptureTargets(args: string[], platform: string, arch: string): string[]
  readManifest(path: string): {
    sourceStamp: string
    artifactSha256: string
    target: string
  }
  replacePathPreserving(source: string, destination: string): void
  runtimeArtifact(
    root: string,
    target: string,
    stamp: string,
    artifactSha256: string,
    generation: string
  ): string
  validateCaptureBinary(addon: string, target: string): void
  verifyCaptureSnapshot(root: string, options: {
    expectedTargets: string | string[]
    electronVersion: string
    expectedSourceStamp?: string
    verifyBinary?: boolean
    allowSignedMacMutation?: boolean
    hostPlatform?: string
    verifySignedMac?: (path: string) => boolean
    canonicalMacDigest?: (path: string) => string
  }): { manifest: { sourceStamp: string; artifactSha256: string; target: string } }
  validCaptureArtifact(input: {
    addon: string
    sourceHash: string
    checksum: string
    expectedSourceStamp: string
  }): boolean
  machCanonicalSha256(path: string): string
}
const captureBuilder = require('../../scripts/build-capture-addon.cjs') as {
  findAddon(buildDir: string): string | null
}
const dist = require('../../scripts/dist.cjs') as {
  electronBuilderArgs(args: string[]): string[]
  finalVerifyCaptureSnapshots(options: {
    projectRoot: string
    targets: string[]
    electronVersion: string
    fingerprint: () => string
    verifySnapshot: (root: string, options: {
      expectedTargets: string | string[]
      electronVersion: string
      expectedSourceStamp: string
    }) => void
  }): void
  hasExplicitPublishArg(args: string[]): boolean
}
const afterPack = require('../../scripts/afterPack.cjs') as {
  verifyCopiedCapture(context: {
    electronPlatformName: string
    arch: number | string
    appOutDir: string
    packager: { appInfo: { productFilename: string } }
  }, overrides: {
    sourceStamp: string
    electronVersion: string
    verifySnapshot: (root: string, options: {
      expectedTargets: string
      electronVersion: string
      expectedSourceStamp: string
    }) => void
  }): { engines: string; expectedTargets: string }
}

const root = process.cwd()
// A Windows checkout can be CRLF; the multi-line toContain assertions embed
// bare \n, so normalize every read.
const read = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n')

describe('Electron capture addon build', () => {
  it.runIf(process.platform === 'darwin')(
    'keeps build-time and packaged-runtime Mach-O canonicalization identical',
    () => {
      expect(artifacts.machCanonicalSha256(process.execPath)).toBe(
        runtimeMachCanonicalSha256(process.execPath)
      )
    }
  )
  it('delay-loads node.exe and resolves imports from the actual host process', () => {
    const cmake = read('CMakeLists.txt')
    const hook = read('native/electron/win_delay_load_hook.cc')

    expect(cmake).toContain('target_sources(singz_capture PRIVATE\n      native/electron/win_delay_load_hook.cc)')
    expect(cmake).toContain('target_link_options(singz_capture PRIVATE "/DELAYLOAD:node.exe")')
    expect(cmake).toContain('delayimp')
    expect(hook).toContain('GetModuleHandleW(nullptr)')
    expect(hook).toContain('__pfnDliNotifyHook2 = loadHostBinary')
  })

  it('retires capture on renderer crash and main-document navigation', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain("e.sender.on('render-process-gone', gone)")
    expect(main).toContain("e.sender.on('did-start-navigation'")
    expect(main).toContain('if (isMainFrame) gone()')
  })

  it('keeps only the latest scalar window instead of a deep TSFN FIFO', () => {
    const addon = read('native/electron/capture_addon.cpp')
    expect(addon).toContain('std::atomic<AnalysisWindow*> latest')
    expect(addon).toContain('name, 1, 1,')
    expect(addon).toContain('overwrittenWindows')
    expect(addon).not.toContain('name, 64, 1,')
  })

  it('gives every checkout fingerprint an immutable runtime path', () => {
    const first = artifacts.runtimeArtifact(
      '/checkout-a', 'darwin-arm64', 'a'.repeat(40), '1'.repeat(64), 'generation-a'
    )
    const sibling = artifacts.runtimeArtifact(
      '/checkout-b', 'darwin-arm64', 'a'.repeat(40), '1'.repeat(64), 'generation-a'
    )
    const changedSource = artifacts.runtimeArtifact(
      '/checkout-a', 'darwin-arm64', 'b'.repeat(40), '1'.repeat(64), 'generation-a'
    )
    const changedBinary = artifacts.runtimeArtifact(
      '/checkout-a', 'darwin-arm64', 'a'.repeat(40), '2'.repeat(64), 'generation-b'
    )
    expect(new Set([first, sibling, changedSource, changedBinary]).size).toBe(4)
    expect(first.replaceAll('\\', '/')).toContain(`/${'1'.repeat(64)}/generation-a/`)
    expect(first.replaceAll('\\', '/')).not.toContain('/vendor/')
  })

  it('uses the same native-source fingerprint in the builder and app loader', () => {
    const electronVersion = JSON.parse(read('node_modules/electron/package.json')).version as string
    const built = spawnSync(
      process.execPath,
      [resolve(root, 'scripts/build-capture-addon.cjs'), '--print-source-fingerprint'],
      { cwd: root, encoding: 'utf8' }
    )
    expect(built.status).toBe(0)
    expect(built.stdout.trim()).toBe(captureSourceFingerprint(root, electronVersion))
  })

  it('invalidates a checksummed artifact after its bytes are corrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'singz-capture-artifact-'))
    try {
      const addon = join(dir, 'singz-capture.node')
      const bytes = Buffer.from('known-good-native-artifact')
      const sourceStamp = 'a'.repeat(40)
      writeFileSync(addon, bytes)
      writeFileSync(`${addon}.source-hash`, sourceStamp)
      writeFileSync(`${addon}.sha256`, createHash('sha256').update(bytes).digest('hex'))
      const input = {
        addon,
        sourceHash: `${addon}.source-hash`,
        checksum: `${addon}.sha256`,
        expectedSourceStamp: sourceStamp
      }
      expect(artifacts.validCaptureArtifact(input)).toBe(true)
      writeFileSync(addon, 'corrupt')
      expect(artifacts.validCaptureArtifact(input)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps package flags to every requested capture target', () => {
    expect(artifacts.requestedCaptureTargets(['--mac', '--x64'], 'darwin', 'arm64')).toEqual([
      'darwin-x64'
    ])
    expect(artifacts.requestedCaptureTargets(['--mac', '--universal'], 'darwin', 'arm64')).toEqual([
      'darwin-arm64', 'darwin-x64'
    ])
    expect(artifacts.requestedCaptureTargets(
      ['--mac', '--arm64', '--x64'], 'darwin', 'arm64'
    )).toEqual(['darwin-arm64', 'darwin-x64'])
    expect(() => artifacts.requestedCaptureTargets(['--win'], 'darwin', 'arm64')).toThrow(
      'Cross-OS capture packaging is not configured'
    )
    expect(() => artifacts.requestedCaptureTargets(['--mac'], 'win32', 'x64')).toThrow(
      'Cross-OS capture packaging is not configured'
    )
    expect(artifacts.requestedCaptureTargets(['--win'], 'win32', 'x64')).toEqual(['win32-x64'])
    expect(() => artifacts.requestedCaptureTargets(['--win', '--arm64'], 'win32', 'x64')).toThrow(
      'Windows capture packaging is x64 only'
    )
    expect(() => artifacts.requestedCaptureTargets(['--universal'], 'win32', 'x64')).toThrow(
      'Universal capture packaging is macOS only'
    )
    expect(artifacts.requestedCaptureTargets([], 'darwin', 'arm64')).toEqual(['darwin-arm64'])
    expect(() => artifacts.assertHostCanBuildTarget('win32-x64', 'darwin')).toThrow(
      'Cross-OS capture builds are not configured'
    )
    expect(() => artifacts.assertHostCanBuildTarget('darwin-x64', 'darwin')).not.toThrow()
  })

  it('rejects builder target syntax the capture pipeline cannot reproduce exactly', () => {
    for (const args of [
      ['--linux'], ['-l'], ['--ia32'], ['--armv7l'], ['-o'],
      ['--x64=false'], ['--arm64=false'], ['--universal=false'],
      ['--mac=false'], ['--win=false'], ['dmg:x64'], ['nsis:arm64']
    ]) {
      expect(
        () => artifacts.requestedCaptureTargets(args, 'darwin', 'arm64'),
        args.join(' ')
      ).toThrow()
    }
    expect(() => artifacts.requestedCaptureTargets(
      ['--mac', '--universal', '--x64'], 'darwin', 'arm64'
    )).toThrow('Do not combine --universal')

    for (const arg of [
      '-mw', '-mwl', '-mp', '-wp', '-pfoo',
      '--prepackaged', '--prepackaged=dist/old', '--pd', '--pd=dist/old',
      '--projectDir', '--projectDir=elsewhere', '--projectDir.foo=bar',
      '--project', '--project=elsewhere',
      '-c', '-c=other.yml', '-c.foo=bar', '--config', '--config=other.yml', '--config.foo=bar'
    ]) {
      expect(
        () => artifacts.requestedCaptureTargets([arg], 'darwin', 'arm64'),
        arg
      ).toThrow()
    }
    expect(artifacts.requestedCaptureTargets(['-m'], 'darwin', 'arm64')).toEqual(['darwin-arm64'])
    expect(artifacts.requestedCaptureTargets(['-w'], 'win32', 'x64')).toEqual(['win32-x64'])
    expect(artifacts.requestedCaptureTargets(['-p=never'], 'darwin', 'arm64')).toEqual([
      'darwin-arm64'
    ])
    for (const args of [
      ['publish', '-f', 'old', '-p', 'always'],
      ['start'], ['install-app-deps'], ['node-gyp-rebuild'],
      ['create-self-signed-cert'], ['clear-cache'], ['--'],
      ['--mac', '--x64', '--no-x64', '--dir']
    ]) {
      expect(
        () => artifacts.requestedCaptureTargets(args, 'darwin', 'arm64'),
        args.join(' ')
      ).toThrow()
    }
    for (const flag of [
      '--no-arm64', '--no-universal', '--no-mac', '--no-macos', '--no-m',
      '--no-win', '--no-windows', '--no-w', '--no-linux', '--no-l',
      '--no-ia32', '--no-armv7l', '--no-o', '--no-x64=true', '--no-arm64=false'
    ]) {
      expect(() => artifacts.requestedCaptureTargets([flag], 'darwin', 'arm64')).toThrow(
        'Negated electron-builder build-selection flags'
      )
    }
    expect(artifacts.requestedCaptureTargets(['build', '--mac'], 'darwin', 'arm64')).toEqual([
      'darwin-arm64'
    ])
  })

  it('preserves every explicit electron-builder publish spelling', () => {
    for (const args of [
      ['--publish', 'always'], ['--publish=always'], ['-p', 'always'], ['-p=always']
    ]) {
      expect(dist.hasExplicitPublishArg(args)).toBe(true)
      expect(dist.electronBuilderArgs(args)).toEqual(args)
    }
    expect(dist.electronBuilderArgs(['--mac', '--dir'])).toEqual([
      '--mac', '--dir', '--publish', 'never'
    ])
  })

  it('selects only the generator-configured Release addon from a reused build tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'singz-capture-multiconfig-'))
    try {
      mkdirSync(join(dir, 'Debug'), { recursive: true })
      mkdirSync(join(dir, 'Release'), { recursive: true })
      writeFileSync(join(dir, 'Debug', 'singz-capture.node'), 'stale debug')
      writeFileSync(join(dir, 'Release', 'singz-capture.node'), 'fresh release')
      writeFileSync(
        join(dir, 'CMakeCache.txt'),
        'CMAKE_CONFIGURATION_TYPES:STRING=Debug;Release;RelWithDebInfo\n'
      )
      expect(captureBuilder.findAddon(dir)).toBe(
        join(dir, 'Release', 'singz-capture.node')
      )
      rmSync(join(dir, 'Release', 'singz-capture.node'))
      expect(captureBuilder.findAddon(dir)).toBeNull()

      writeFileSync(join(dir, 'CMakeCache.txt'), 'CMAKE_BUILD_TYPE:STRING=Release\n')
      writeFileSync(join(dir, 'singz-capture.node'), 'single-config release')
      expect(captureBuilder.findAddon(dir)).toBe(join(dir, 'singz-capture.node'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rechecks source identity immediately at the packaging boundary', () => {
    const sourceStamp = 'e'.repeat(40)
    const seen: Array<{ root: string; source: string }> = []
    dist.finalVerifyCaptureSnapshots({
      projectRoot: '/checkout',
      targets: ['darwin-arm64'],
      electronVersion: '43.2.0',
      fingerprint: () => sourceStamp,
      verifySnapshot: (snapshotRoot, options) => {
        seen.push({ root: snapshotRoot, source: options.expectedSourceStamp })
      }
    })
    expect(seen).toEqual([{
      root: join('/checkout', 'build', 'capture-package', 'darwin-arm64'),
      source: sourceStamp
    }])

    let calls = 0
    expect(() => dist.finalVerifyCaptureSnapshots({
      projectRoot: '/checkout',
      targets: ['darwin-arm64'],
      electronVersion: '43.2.0',
      fingerprint: () => (++calls === 1 ? sourceStamp : 'f'.repeat(40)),
      verifySnapshot: () => undefined
    })).toThrow('Capture native sources changed during final packaging verification')

    const fixture = mkdtempSync(join(tmpdir(), 'singz-capture-final-verify-'))
    try {
      const snapshot = join(fixture, 'build', 'capture-package', 'darwin-arm64')
      mkdirSync(snapshot, { recursive: true })
      const addon = join(snapshot, 'singz-capture.node')
      const bytes = Buffer.from('artifact built before the source edit')
      const artifactSha256 = createHash('sha256').update(bytes).digest('hex')
      writeFileSync(addon, bytes)
      writeFileSync(`${addon}.source-hash`, sourceStamp)
      writeFileSync(`${addon}.sha256`, artifactSha256)
      writeFileSync(join(snapshot, 'singz-capture.manifest.json'), JSON.stringify({
        format: 1,
        target: 'darwin-arm64',
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '43.2.0',
        sourceStamp,
        artifactSha256,
        machCanonicalSha256: '6'.repeat(64),
        generation: 'before-edit',
        addon: 'singz-capture.node'
      }))
      expect(() => dist.finalVerifyCaptureSnapshots({
        projectRoot: fixture,
        targets: ['darwin-arm64'],
        electronVersion: '43.2.0',
        fingerprint: () => 'f'.repeat(40),
        verifySnapshot: (snapshotRoot, options) => {
          artifacts.verifyCaptureSnapshot(snapshotRoot, { ...options, verifyBinary: false })
        }
      })).toThrow(`Capture artifact source ${sourceStamp}, expected ${'f'.repeat(40)}`)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a build result if its source fingerprint changed', () => {
    expect(() => artifacts.assertSourceFingerprintUnchanged('a', 'b', 'during the build')).toThrow(
      'Capture native sources changed during the build'
    )
    expect(() => artifacts.assertSourceFingerprintUnchanged('a', 'a', 'during the build')).not.toThrow()
  })

  it('configures optimized Release output for single-config generators', () => {
    expect(read('scripts/build-capture-addon.cjs')).toContain("'-DCMAKE_BUILD_TYPE=Release'")
  })

  it('validates a Windows artifact as PE x64 without loading it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'singz-capture-pe-'))
    try {
      const addon = join(dir, 'singz-capture.node')
      const bytes = Buffer.alloc(256)
      bytes.write('MZ', 0, 'ascii')
      bytes.writeUInt32LE(0x80, 0x3c)
      bytes.write('PE\0\0', 0x80, 'binary')
      bytes.writeUInt16LE(0x8664, 0x84)
      writeFileSync(addon, bytes)
      expect(() => artifacts.validateCaptureBinary(addon, 'win32-x64')).not.toThrow()
      bytes.writeUInt16LE(0x014c, 0x84)
      writeFileSync(addon, bytes)
      expect(() => artifacts.validateCaptureBinary(addon, 'win32-x64')).toThrow('not a PE x64')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('packages and smoke-checks one coherent worktree-local snapshot', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    const builder = read('electron-builder.yml')
    const smoke = read('tests/e2e/capture-addon-smoke.cjs')
    const checks = read('.github/workflows/checks.yml')
    expect(packageJson.scripts.dist).toBe('node scripts/dist.cjs')
    expect(builder).toContain('from: build/capture-package/darwin-${arch}')
    expect(builder).toContain('from: build/capture-package/win32-x64')
    expect(builder).toContain("x64ArchFiles: '**/engines/singz-capture.node'")
    expect(builder.match(/singz-capture\.node\.source-hash/g)).toHaveLength(2)
    expect(builder.match(/singz-capture\.node\.sha256/g)).toHaveLength(2)
    expect(builder.match(/singz-capture\.manifest\.json/g)).toHaveLength(2)
    expect(smoke).toContain('verifyCaptureArtifact({')
    expect(smoke).toContain('expectedSourceStamp: expectsCurrentSource ? sourceFingerprint() : undefined')
    expect(smoke).toContain("assert.equal(addon.buildInfo.sourceStamp, manifest.sourceStamp")
    expect(packageJson.scripts['capture:verify']).toContain('--current-source')
    expect(read('tests/e2e/capture-addon-hardware.cjs')).toContain(
      'expectedSourceStamp: sourceFingerprint()'
    )
    expect(checks).toContain('runs-on: macos-15-intel')
    expect(checks).toContain('  capture-macos:\n')
    expect(checks).toContain('npm run dist -- --win --x64 --dir')
    expect(checks).toContain('> vendor/win32-x64/whisper-cli\n')
    expect(checks).not.toContain('vendor/win32-x64/whisper-cli.exe')
    expect(checks).toContain('dist/win-unpacked/resources/engines/singz-capture.node --current-source')
    expect(checks).toContain('capture-addon-signed-mac.cjs dist/mac-universal/SingZ.app')
    expect(smoke).toContain("assert.equal(addon.buildInfo.electronVersion, process.versions.electron")

    const dir = mkdtempSync(join(tmpdir(), 'singz-capture-package-'))
    try {
      const addon = join(dir, 'singz-capture.node')
      const bytes = Buffer.from('package-snapshot')
      const sourceStamp = 'c'.repeat(40)
      const artifactSha256 = createHash('sha256').update(bytes).digest('hex')
      const canonicalSha256 = '5'.repeat(64)
      writeFileSync(addon, bytes)
      writeFileSync(`${addon}.source-hash`, sourceStamp)
      writeFileSync(`${addon}.sha256`, artifactSha256)
      const manifestPath = join(dir, 'singz-capture.manifest.json')
      writeFileSync(manifestPath, JSON.stringify({
        format: 1,
        target: 'darwin-arm64',
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '43.2.0',
        sourceStamp,
        artifactSha256,
        machCanonicalSha256: canonicalSha256,
        generation: 'generation-c',
        addon: 'singz-capture.node'
      }))
      const { manifest } = artifacts.verifyCaptureSnapshot(dir, {
        expectedTargets: 'darwin-arm64',
        electronVersion: '43.2.0',
        verifyBinary: false,
        canonicalMacDigest: () => canonicalSha256
      })
      expect(manifest).toMatchObject({ sourceStamp, artifactSha256, target: 'darwin-arm64' })
      expect(artifacts.validCaptureArtifact({
        addon,
        sourceHash: `${addon}.source-hash`,
        checksum: `${addon}.sha256`,
        expectedSourceStamp: manifest.sourceStamp
      })).toBe(true)
      writeFileSync(manifestPath, JSON.stringify({
        format: 1,
        target: 'darwin-arm64',
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '43.2.0',
        sourceStamp,
        artifactSha256: 'd'.repeat(64),
        machCanonicalSha256: canonicalSha256,
        generation: 'generation-c',
        addon: 'singz-capture.node'
      }))
      expect(() => artifacts.verifyCaptureSnapshot(dir, {
        expectedTargets: 'darwin-arm64',
        electronVersion: '43.2.0',
        verifyBinary: false,
        canonicalMacDigest: () => canonicalSha256
      })).toThrow('incomplete or corrupt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts changed macOS signature bytes only through the explicit signed package mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'singz-capture-signed-package-'))
    try {
      const addon = join(dir, 'singz-capture.node')
      const original = Buffer.from('unsigned mach-o fixture')
      const sourceStamp = '9'.repeat(40)
      const artifactSha256 = createHash('sha256').update(original).digest('hex')
      const canonicalSha256 = '4'.repeat(64)
      writeFileSync(addon, Buffer.from('same binary after signing changed its bytes'))
      writeFileSync(`${addon}.source-hash`, sourceStamp)
      writeFileSync(`${addon}.sha256`, artifactSha256)
      writeFileSync(join(dir, 'singz-capture.manifest.json'), JSON.stringify({
        format: 1,
        target: 'darwin-arm64',
        platform: 'darwin',
        arch: 'arm64',
        electronVersion: '43.2.0',
        sourceStamp,
        artifactSha256,
        machCanonicalSha256: canonicalSha256,
        generation: 'signed-fixture',
        addon: 'singz-capture.node'
      }))
      const options = {
        expectedTargets: 'darwin-arm64',
        electronVersion: '43.2.0',
        verifyBinary: false,
        hostPlatform: 'darwin',
        canonicalMacDigest: () => canonicalSha256
      }
      expect(() => artifacts.verifyCaptureSnapshot(dir, {
        ...options,
        verifySignedMac: () => true
      })).toThrow('incomplete or corrupt')
      expect(() => artifacts.verifyCaptureSnapshot(dir, {
        ...options,
        allowSignedMacMutation: true,
        verifySignedMac: () => false
      })).toThrow('incomplete or corrupt')
      expect(() => artifacts.verifyCaptureSnapshot(dir, {
        ...options,
        allowSignedMacMutation: true,
        hostPlatform: 'win32',
        verifySignedMac: () => true
      })).toThrow('incomplete or corrupt')
      expect(() => artifacts.verifyCaptureSnapshot(dir, {
        ...options,
        allowSignedMacMutation: true,
        verifySignedMac: () => true
      })).not.toThrow()
      expect(() => artifacts.verifyCaptureSnapshot(dir, {
        ...options,
        allowSignedMacMutation: true,
        canonicalMacDigest: () => '3'.repeat(64),
        verifySignedMac: () => true
      })).toThrow('canonical Mach-O digest mismatch')
      writeFileSync(`${addon}.sha256`, '8'.repeat(64))
      expect(() => artifacts.verifyCaptureSnapshot(dir, {
        ...options,
        allowSignedMacMutation: true,
        verifySignedMac: () => true
      })).toThrow('incomplete or corrupt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restores the last good package snapshot if installation fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'singz-capture-snapshot-swap-'))
    try {
      const destination = join(dir, 'darwin-arm64')
      mkdirSync(destination)
      writeFileSync(join(destination, 'known-good'), 'preserve me')
      expect(() => artifacts.replacePathPreserving(join(dir, 'missing-staging'), destination)).toThrow()
      expect(readFileSync(join(destination, 'known-good'), 'utf8')).toBe('preserve me')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defers ad-hoc signing until the universal app has been merged', () => {
    const hook = read('scripts/afterPack.cjs')
    expect(hook).toContain('/-universal-(?:x64|arm64)-temp$/')
    expect(hook.indexOf('universal intermediate')).toBeLessThan(
      hook.indexOf("execFileSync('/usr/bin/codesign'")
    )
    expect(read('src/main/capture.ts')).toContain("spawnSync('/usr/bin/codesign'")
    expect(read('scripts/capture-artifact.cjs')).toContain("'/usr/bin/codesign'")
    expect(hook).toContain('const layout = verifyCopiedCapture(context)')
    expect(hook.indexOf('verifyCopiedCapture(context)')).toBeLessThan(
      hook.indexOf('layout.universalIntermediate')
    )
    expect(hook).not.toContain('CSC_LINK')
  })

  it('verifies the artifact electron-builder actually copied before afterPack returns', () => {
    const sourceStamp = '7'.repeat(40)
    const seen: Array<{ root: string; target: string }> = []
    const common = {
      sourceStamp,
      electronVersion: '43.2.0',
      verifySnapshot: (snapshotRoot: string, options: { expectedTargets: string }) => {
        seen.push({ root: snapshotRoot, target: options.expectedTargets })
      }
    }
    afterPack.verifyCopiedCapture({
      electronPlatformName: 'darwin',
      arch: 3,
      appOutDir: '/package/mac-arm64',
      packager: { appInfo: { productFilename: 'SingZ' } }
    }, common)
    afterPack.verifyCopiedCapture({
      electronPlatformName: 'win32',
      arch: 1,
      appOutDir: 'C:\\package\\win-unpacked',
      packager: { appInfo: { productFilename: 'SingZ' } }
    }, common)
    expect(seen).toEqual([
      {
        root: join('/package/mac-arm64', 'SingZ.app', 'Contents', 'Resources', 'engines'),
        target: 'darwin-arm64'
      },
      {
        root: join('C:\\package\\win-unpacked', 'resources', 'engines'),
        target: 'win32-x64'
      }
    ])
    expect(() => afterPack.verifyCopiedCapture({
      electronPlatformName: 'darwin',
      arch: 3,
      appOutDir: '/package/stale',
      packager: { appInfo: { productFilename: 'SingZ' } }
    }, {
      ...common,
      verifySnapshot: () => { throw new Error('stale copied fixture') }
    })).toThrow('stale copied fixture')
  })

  it('keys temporary CMake caches by the full checkout path', () => {
    for (const path of [
      'scripts/build-analyze-host.sh',
      'scripts/run-core-host-tests.sh',
      'scripts/vendor-analyze.sh'
    ]) {
      const script = read(path)
      expect(script).toContain('git -C "$ROOT" hash-object --stdin | cut -c1-12')
      expect(script).not.toContain('$(basename "$ROOT")')
    }
  })
})
