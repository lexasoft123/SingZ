#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ffmpegCanonicalHeaderFormat,
  ffmpegFrameworkDependencies,
  ffmpegFrameworkHeaderContents,
  ffmpegFrameworkHeaderName,
  ffmpegFrameworkHeaderSurface,
  ffmpegFrameworkInstallName,
  ffmpegFrameworkModuleMap,
  ffmpegFrameworkName,
  ffmpegFrameworkPackagingFormat,
  validateFfmpegFrameworkBytes,
} from './ffmpeg-runtime-binary.mjs'
import { assertExactManifestTree } from './strict-pack-files.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const valueAfter = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}
const pack = resolve(process.argv.includes('--pack')
  ? valueAfter('--pack')
  : join(root, 'vendor', 'ffmpeg-codec', 'ios-xcframeworks'))
const profile = JSON.parse(
  readFileSync(join(root, 'third_party', 'ffmpeg-codec', 'profile.json'), 'utf8'),
)
const proofStaging = process.argv.includes('--proof-staging')
if (proofStaging && process.env.SINGZ_CODEC_TARGET_PROOF !== '1')
  throw new Error('--proof-staging requires SINGZ_CODEC_TARGET_PROOF=1')
if (proofStaging && process.argv.includes('--require-full'))
  throw new Error('--proof-staging cannot be combined with --require-full')
const manifestPath = join(pack, 'manifest.json')
if (!existsSync(manifestPath)) throw new Error(`Missing iOS XCFramework manifest: ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const components = ['avcodec', 'avformat', 'avutil', 'swresample']
const expectedMode = proofStaging ? 'target-proof-staging' : 'release-proven'
if (manifest.mode !== expectedMode)
  throw new Error(`iOS FFmpeg XCFramework mode is ${manifest.mode || 'missing'}, expected ${expectedMode}`)
const expectedPackaging = {
  format: ffmpegFrameworkPackagingFormat,
  dynamic: true,
  headers: {
    format: ffmpegCanonicalHeaderFormat,
    root: 'include',
    frameworkSurface: ffmpegFrameworkHeaderSurface,
  },
  frameworks: Object.fromEntries(components.map((component) => [component, {
    bundle: `${ffmpegFrameworkName(component)}.framework`,
    executable: ffmpegFrameworkName(component),
    entryHeader: ffmpegFrameworkHeaderName(component),
    installName: ffmpegFrameworkInstallName(component),
    dependencies: ffmpegFrameworkDependencies[component].map(ffmpegFrameworkInstallName),
  }])),
}
if (manifest.format !== 2 ||
    manifest.profile !== profile.profile ||
    manifest.target !== 'ios-xcframeworks' ||
    manifest.capabilityMask !== profile.capabilityMask ||
    JSON.stringify(manifest.source) !== JSON.stringify(profile.source) ||
    JSON.stringify(manifest.components) !== JSON.stringify(components) ||
    JSON.stringify(manifest.packaging) !== JSON.stringify(expectedPackaging))
  throw new Error('iOS FFmpeg XCFramework pack does not match the pinned product profile')

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
if (!Array.isArray(manifest.files) || manifest.files.length < 20 || manifest.files.length > 4096)
  throw new Error('iOS FFmpeg XCFramework file manifest is unreasonable')
const seen = new Set()
for (const row of manifest.files) {
  if (typeof row?.path !== 'string' || row.path.startsWith('/') || row.path.includes('\\') ||
      row.path.split('/').includes('..') || seen.has(row.path) ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      !Number.isSafeInteger(row.bytes) || row.bytes < 0)
    throw new Error(`Malformed iOS XCFramework file row: ${JSON.stringify(row)}`)
  const path = join(pack, row.path)
  if (!existsSync(path) || !statSync(path).isFile() ||
      statSync(path).size !== row.bytes || sha256(path) !== row.sha256)
    throw new Error(`iOS XCFramework file changed after publication: ${row.path}`)
  seen.add(row.path)
}
assertExactManifestTree({
  root: pack,
  rows: manifest.files,
  allowedRootFiles: ['manifest.json'],
  label: 'iOS FFmpeg XCFramework pack',
})
for (const component of components) {
  const name = ffmpegFrameworkName(component)
  const prefix = `${name}.xcframework`
  if (!seen.has(`${prefix}/Info.plist`))
    throw new Error(`Missing lib${component}.xcframework metadata`)
  if (manifest.files.some((row) => row.path.startsWith(`${prefix}/`) && row.path.endsWith('.dylib')))
    throw new Error(`${name}.xcframework contains a raw dylib instead of a framework executable`)
  for (const slice of [
    { directory: 'ios-arm64', target: 'ios-arm64', supportedPlatform: 'iPhoneOS' },
    {
      directory: 'ios-arm64_x86_64-simulator',
      target: 'ios-simulator-universal',
      supportedPlatform: 'iPhoneSimulator',
    },
  ]) {
    const framework = `${prefix}/${slice.directory}/${name}.framework`
    const executable = `${framework}/${name}`
    const entryHeader = `${framework}/Headers/${ffmpegFrameworkHeaderName(component)}`
    for (const required of [
      executable,
      `${framework}/Info.plist`,
      `${framework}/Modules/module.modulemap`,
      entryHeader,
    ]) {
      if (!seen.has(required)) throw new Error(`Missing iOS framework member: ${required}`)
    }
    const frameworkHeaders = manifest.files
      .map((row) => row.path)
      .filter((path) => path.startsWith(`${framework}/Headers/`))
    if (JSON.stringify(frameworkHeaders) !== JSON.stringify([entryHeader])) {
      throw new Error(
        `${framework} exposes forbidden flat FFmpeg headers instead of its single runtime marker`,
      )
    }
    validateFfmpegFrameworkBytes({
      bytes: readFileSync(join(pack, executable)), target: slice.target, component,
      profile, path: executable,
    })
    const plist = readFileSync(join(pack, framework, 'Info.plist'), 'utf8')
    for (const required of [
      `<key>CFBundleExecutable</key><string>${name}</string>`,
      `<key>CFBundleIdentifier</key><string>org.ffmpeg.${name}</string>`,
      '<key>CFBundlePackageType</key><string>FMWK</string>',
      `<key>CFBundleSupportedPlatforms</key><array><string>${slice.supportedPlatform}</string></array>`,
    ]) {
      if (!plist.includes(required))
        throw new Error(`${framework}/Info.plist is missing ${required}`)
    }
    const moduleMap = readFileSync(join(pack, framework, 'Modules', 'module.modulemap'), 'utf8')
    if (moduleMap !== ffmpegFrameworkModuleMap(component))
      throw new Error(`${framework} does not expose its headers as a framework module`)
    if (readFileSync(join(pack, entryHeader), 'utf8') !==
        ffmpegFrameworkHeaderContents(component))
      throw new Error(`${framework} runtime marker header changed`)
  }
}
for (const component of components) {
  if (!seen.has(`include/lib${component}/${component}.h`))
    throw new Error(`Missing canonical namespaced FFmpeg header: lib${component}/${component}.h`)
}
for (const target of ['ios-arm64', 'ios-simulator-arm64', 'ios-simulator-x64']) {
  const sourcePack = join(root, 'vendor', 'ffmpeg-codec', target)
  const sourceManifest = join(sourcePack, 'manifest.json')
  if (!existsSync(sourceManifest) ||
      manifest.slices?.[target]?.packManifestSha256 !== sha256(sourceManifest))
    throw new Error(`iOS XCFramework pack is not bound to ${target}`)
  if (process.argv.includes('--require-full')) {
    if (manifest.slices[target].fullMatrixFixtureEvidence !== true)
      throw new Error(`iOS XCFramework source ${target} lacks target fixture evidence`)
    execFileSync(process.execPath, [
      join(root, 'scripts', 'verify-ffmpeg-codec-pack.mjs'),
      '--pack', sourcePack, '--require-full',
    ], { stdio: 'inherit' })
  }
}
for (const name of ['NOTICE-FFMPEG.md', 'COPYING.LGPLv2.1-FFMPEG', 'profile.json']) {
  if (!seen.has(`compliance/${name}`)) throw new Error(`Missing iOS compliance/${name}`)
}
console.log(
  `iOS FFmpeg XCFramework pack verified: ${manifest.files.length} files` +
    (process.argv.includes('--require-full') ? ' + target fixtures' : ''),
)
