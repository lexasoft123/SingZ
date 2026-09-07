import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertExactManifestTree,
  assertExactSelectionTree,
} from '../../scripts/strict-pack-files.mjs'

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

const write = (root: string, relative: string, contents: string): void => {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

const row = (root: string, path: string) => ({
  path,
  bytes: readFileSync(join(root, path)).length,
  sha256: sha256(join(root, path)),
})

const profile = JSON.parse(
  readFileSync(resolve(process.cwd(), 'third_party/ffmpeg-codec/profile.json'), 'utf8'),
)
const verifier = resolve(process.cwd(), 'scripts/verify-ffmpeg-codec-pack.mjs')
const configure = [
  '--disable-everything',
  '--disable-static',
  '--enable-shared',
  '--disable-network',
  `--enable-demuxer=${profile.requiredDemuxers.join(',')}`,
  `--enable-decoder=${profile.requiredDecoders.join(',')}`,
  `--enable-parser=${profile.requiredParsers.join(',')}`,
].join(' ')

const peRuntime = (component: string): Buffer => {
  const configuration = component === 'avcodec' || component === 'avformat'
    ? Buffer.from(`${configure}\0`, 'utf8')
    : Buffer.alloc(0)
  const bytes = Buffer.alloc(128 + configuration.length)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(0x40, 0x3c)
  bytes.write('PE\0\0', 0x40, 'ascii')
  bytes.writeUInt16LE(0x8664, 0x44)
  bytes.writeUInt16LE(0x2000, 0x40 + 22)
  configuration.copy(bytes, 128)
  return bytes
}

const createSyntheticPack = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'singz-source-pack-'))
  const components = ['avcodec', 'avformat', 'avutil', 'swresample']
  const runtimeLibraries = Object.fromEntries(components.map((component) => {
    const relative = `bin/${component}-${profile.abiMajors[component]}.dll`
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, peRuntime(component))
    return [component, relative]
  }))
  for (const relative of [
    'compliance/NOTICE-FFMPEG.md',
    'compliance/COPYING.LGPLv2.1-FFMPEG',
    'compliance/profile.json',
    'share/singz-ffmpeg/configuration.txt',
  ]) write(root, relative, relative.endsWith('configuration.txt') ? `${configure}\n` : `${relative}\n`)
  const files = [
    ...Object.values(runtimeLibraries),
    'compliance/NOTICE-FFMPEG.md',
    'compliance/COPYING.LGPLv2.1-FFMPEG',
    'compliance/profile.json',
    'share/singz-ffmpeg/configuration.txt',
  ].sort().map((path) => row(root, path))
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify({
    format: 1,
    profile: profile.profile,
    target: 'win32-x64',
    source: profile.source,
    abiMajors: profile.abiMajors,
    capabilityMask: profile.capabilityMask,
    requiredDemuxers: profile.requiredDemuxers,
    requiredDecoders: profile.requiredDecoders,
    requiredParsers: profile.requiredParsers,
    configuration: configure,
    runtimeLibraries,
    fixtureEvidence: { fullMatrix: false },
    files,
  }, null, 2)}\n`)
  return root
}

const verifyPack = (root: string) => spawnSync(
  process.execPath,
  [verifier, '--pack', root],
  { encoding: 'utf8' },
)

const expectUndeclaredRejected = (mutate: (root: string) => void): void => {
  const root = createSyntheticPack()
  try {
    expect(verifyPack(root).status).toBe(0)
    mutate(root)
    const result = verifyPack(root)
    expect(result.status).toBe(1)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /actual file set differs|unsupported filesystem entry/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('strict packaged file sets', () => {
  it('rejects an undeclared flat Headers/time.h beside the marker-only surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-xc-files-'))
    try {
      write(root, 'manifest.json', '{}\n')
      write(root, 'libavutil.framework/Headers/SingzFfmpegAvutilRuntime.h', '#define MARKER 1\n')
      const rows = [row(root, 'libavutil.framework/Headers/SingzFfmpegAvutilRuntime.h')]
      expect(() => assertExactManifestTree({
        root, rows, allowedRootFiles: ['manifest.json'], label: 'fixture XC pack',
      })).not.toThrow()

      write(root, 'libavutil.framework/Headers/time.h', '#define AV_TIME_BASE 1000000\n')
      expect(() => assertExactManifestTree({
        root, rows, allowedRootFiles: ['manifest.json'], label: 'fixture XC pack',
      })).toThrow(/undeclared: .*Headers\/time\.h/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a changed modulemap and a second framework header', () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-xc-module-'))
    try {
      const modulemap = 'libavcodec.framework/Modules/module.modulemap'
      const marker = 'libavcodec.framework/Headers/SingzFfmpegAvcodecRuntime.h'
      write(root, 'manifest.json', '{}\n')
      write(root, modulemap, 'framework module libavcodec { export * }\n')
      write(root, marker, '#define MARKER 1\n')
      const rows = [row(root, modulemap), row(root, marker)]

      write(root, modulemap, 'framework module libavcodec { umbrella "." }\n')
      expect(() => assertExactManifestTree({
        root, rows, allowedRootFiles: ['manifest.json'], label: 'fixture XC pack',
      })).toThrow(/file changed after publication: .*module\.modulemap/)

      write(root, modulemap, 'framework module libavcodec { export * }\n')
      write(root, 'libavcodec.framework/Headers/alternate.h', '#define ALTERNATE 1\n')
      expect(() => assertExactManifestTree({
        root, rows, allowedRootFiles: ['manifest.json'], label: 'fixture XC pack',
      })).toThrow(/undeclared: .*Headers\/alternate\.h/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects an undeclared file in the staged iOS target-proof selection', () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-ios-selection-'))
    try {
      const relative = 'libavutil.xcframework/ios-arm64/libavutil.framework/libavutil'
      write(root, relative, 'runtime bytes')
      const published = row(root, relative)
      const rows = [{
        source: relative,
        destination: `common/cpp/audioapi/external/ffmpeg_ios/${relative}`,
        bytes: published.bytes,
        sha256: published.sha256,
      }]
      expect(() => assertExactSelectionTree({
        root,
        rows,
        destinationPrefix: 'common/cpp/audioapi/external/ffmpeg_ios',
        label: 'target-proof iOS selection',
      })).not.toThrow()

      write(root,
        'libavutil.xcframework/ios-arm64/libavutil.framework/Headers/time.h',
        '#define AV_TIME_BASE 1000000\n')
      expect(() => assertExactSelectionTree({
        root,
        rows,
        destinationPrefix: 'common/cpp/audioapi/external/ffmpeg_ios',
        label: 'target-proof iOS selection',
      })).toThrow(/undeclared: .*Headers\/time\.h/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('generic FFmpeg source-pack verifier', () => {
  it.each([
    ['regular file', (root: string) => write(root, 'undeclared.txt', 'extra\n')],
    ['hidden file', (root: string) => write(root, '.undeclared', 'extra\n')],
    ['source include header', (root: string) => write(root, 'include/libavutil/undeclared.h', '#define EXTRA 1\n')],
  ])('rejects an undeclared %s through the real verifier', (_name, mutate) => {
    expectUndeclaredRejected(mutate)
  })

  it.runIf(process.platform !== 'win32')(
    'rejects an undeclared symlink through the real verifier',
    () => expectUndeclaredRejected((root) => symlinkSync('manifest.json', join(root, 'undeclared-link'))),
  )

  it.runIf(process.platform !== 'win32')(
    'rejects an undeclared special entry through the real verifier',
    () => expectUndeclaredRejected((root) => execFileSync('mkfifo', [join(root, 'undeclared-fifo')])),
  )

  it.runIf(process.platform !== 'win32')(
    'rejects a source-pack symlink root through the real verifier',
    () => {
      const realRoot = createSyntheticPack()
      const linkParent = mkdtempSync(join(tmpdir(), 'singz-source-pack-link-'))
      const linkRoot = join(linkParent, 'pack')
      try {
        expect(verifyPack(realRoot).status).toBe(0)
        symlinkSync(realRoot, linkRoot, 'dir')
        const result = verifyPack(linkRoot)
        expect(result.status).toBe(1)
        expect(`${result.stdout}\n${result.stderr}`).toMatch(
          /Pack root must be a real directory, not a symlink or special entry/,
        )
      } finally {
        rmSync(linkParent, { recursive: true, force: true })
        rmSync(realRoot, { recursive: true, force: true })
      }
    },
  )
})
