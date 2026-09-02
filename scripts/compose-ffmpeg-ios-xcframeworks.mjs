#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
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
  validateFfmpegRuntimeBytes,
} from './ffmpeg-runtime-binary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
if (process.platform !== 'darwin') throw new Error('iOS XCFramework composition requires macOS')
const proofStaging = process.argv.includes('--proof-staging')
const replaceExisting = process.argv.includes('--replace-existing')
if (proofStaging && process.env.SINGZ_CODEC_TARGET_PROOF !== '1')
  throw new Error('--proof-staging requires SINGZ_CODEC_TARGET_PROOF=1')
if (!process.env.SINGZ_NATIVE_BUILD_LOCK_HELD) {
  const locked = spawnSync(process.execPath, [
    join(root, 'scripts', 'with-native-build-lock.mjs'),
    '--owner', `ffmpeg-xcframeworks:${proofStaging ? 'proof' : 'release'}`,
    '--', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2),
  ], { cwd: process.cwd(), stdio: 'inherit' })
  if (locked.error) throw locked.error
  process.exit(locked.status ?? 1)
}
execFileSync(process.execPath, [join(root, 'scripts', 'assert-native-build-lock.cjs')], {
  stdio: 'inherit',
})
const output = join(root, 'vendor', 'ffmpeg-codec', 'ios-xcframeworks')
if (existsSync(output) && !replaceExisting) {
  throw new Error(
    `Immutable iOS FFmpeg XCFramework pack already exists: ${output}; verify it or remove that exact pack before rebuilding`,
  )
}
const targetNames = ['ios-arm64', 'ios-simulator-arm64', 'ios-simulator-x64']
const packs = Object.fromEntries(targetNames.map((target) => {
  const path = join(root, 'vendor', 'ffmpeg-codec', target)
  const verifyArgs = [
    join(root, 'scripts', 'verify-ffmpeg-codec-pack.mjs'), '--pack', path,
  ]
  if (!proofStaging) verifyArgs.push('--require-full')
  execFileSync(process.execPath, verifyArgs, { stdio: 'inherit' })
  return [target, { path, manifest: JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) }]
}))
const profile = JSON.parse(
  readFileSync(join(root, 'third_party', 'ffmpeg-codec', 'profile.json'), 'utf8'),
)
const partial = `${output}.part-${process.pid}-${Date.now()}`
const backup = `${output}.backup-${process.pid}-${Date.now()}`
const staging = `${partial}.framework-slices`
rmSync(partial, { recursive: true, force: true })
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

const components = ['avcodec', 'avformat', 'avutil', 'swresample']
const frameworkInfoPlist = ({ component, platform }) => {
  const name = ffmpegFrameworkName(component)
  const supportedPlatform = platform === 'device' ? 'iPhoneOS' : 'iPhoneSimulator'
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>org.ffmpeg.${name}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>${profile.source.version}</string>
  <key>CFBundleSupportedPlatforms</key><array><string>${supportedPlatform}</string></array>
  <key>CFBundleVersion</key><string>${profile.source.version}</string>
  <key>MinimumOSVersion</key><string>15.1</string>
</dict>
</plist>
`
}
const createFrameworkSlice = ({ component, binary, platform, target }) => {
  const name = ffmpegFrameworkName(component)
  const framework = join(staging, platform, `${name}.framework`)
  const executable = join(framework, name)
  mkdirSync(join(framework, 'Headers'), { recursive: true })
  mkdirSync(join(framework, 'Modules'), { recursive: true })
  writeFileSync(
    join(framework, 'Headers', ffmpegFrameworkHeaderName(component)),
    ffmpegFrameworkHeaderContents(component),
  )
  copyFileSync(binary, executable)
  writeFileSync(join(framework, 'Info.plist'), frameworkInfoPlist({ component, platform }))
  writeFileSync(join(framework, 'Modules', 'module.modulemap'), ffmpegFrameworkModuleMap(component))
  execFileSync('install_name_tool', ['-id', ffmpegFrameworkInstallName(component), executable], {
    stdio: 'inherit',
  })
  for (const dependency of ffmpegFrameworkDependencies[component]) {
    execFileSync('install_name_tool', [
      '-change', `@rpath/lib${dependency}.${profile.abiMajors[dependency]}.dylib`,
      ffmpegFrameworkInstallName(dependency), executable,
    ], { stdio: 'inherit' })
  }
  validateFfmpegFrameworkBytes({
    bytes: readFileSync(executable), target, component, profile, path: executable,
  })
  return framework
}

for (const component of components) {
  const device = join(
    packs['ios-arm64'].path,
    packs['ios-arm64'].manifest.runtimeLibraries[component],
  )
  const simulatorArm64 = join(
    packs['ios-simulator-arm64'].path,
    packs['ios-simulator-arm64'].manifest.runtimeLibraries[component],
  )
  const simulatorX64 = join(
    packs['ios-simulator-x64'].path,
    packs['ios-simulator-x64'].manifest.runtimeLibraries[component],
  )
  validateFfmpegRuntimeBytes({
    bytes: readFileSync(device), target: 'ios-arm64', component, profile, path: device,
  })
  validateFfmpegRuntimeBytes({
    bytes: readFileSync(simulatorArm64), target: 'ios-simulator-arm64', component,
    profile, path: simulatorArm64,
  })
  validateFfmpegRuntimeBytes({
    bytes: readFileSync(simulatorX64), target: 'ios-simulator-x64', component,
    profile, path: simulatorX64,
  })
  const universalSimulator = join(staging, `${basename(simulatorArm64)}.universal`)
  execFileSync('xcrun', [
    'lipo', '-create', simulatorArm64, simulatorX64, '-output', universalSimulator,
  ], { stdio: 'inherit' })
  validateFfmpegRuntimeBytes({
    bytes: readFileSync(universalSimulator), target: 'ios-simulator-universal',
    component, profile, path: universalSimulator,
  })
  const deviceFramework = createFrameworkSlice({
    component,
    binary: device,
    platform: 'device',
    target: 'ios-arm64',
  })
  const simulatorFramework = createFrameworkSlice({
    component,
    binary: universalSimulator,
    platform: 'simulator',
    target: 'ios-simulator-universal',
  })
  execFileSync('xcodebuild', [
    '-create-xcframework',
    '-framework', deviceFramework,
    '-framework', simulatorFramework,
    '-output', join(partial, `lib${component}.xcframework`),
  ], { stdio: 'inherit' })
}

cpSync(join(packs['ios-arm64'].path, 'include'), join(partial, 'include'), {
  recursive: true,
  dereference: true,
})
const compliance = join(partial, 'compliance')
mkdirSync(compliance, { recursive: true })
for (const name of [
  'NOTICE-FFMPEG.md',
  'COPYING.LGPLv2.1-FFMPEG',
  'profile.json',
]) {
  const source = name === 'profile.json'
    ? join(root, 'third_party', 'ffmpeg-codec', name)
    : join(root, 'third_party', name)
  copyFileSync(source, join(compliance, name))
}
rmSync(staging, { recursive: true, force: true })

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = []
const walk = (directory, prefix = '') => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(path, name)
    else if (entry.isFile()) files.push({
      path: name,
      bytes: statSync(path).size,
      sha256: sha256(path),
    })
    else throw new Error(`XCFramework pack contains unsupported entry: ${path}`)
  }
}
walk(partial)
files.sort((left, right) => left.path.localeCompare(right.path))
const manifest = {
  format: 2,
  mode: proofStaging ? 'target-proof-staging' : 'release-proven',
  profile: profile.profile,
  target: 'ios-xcframeworks',
  source: profile.source,
  capabilityMask: profile.capabilityMask,
  components,
  packaging: {
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
  },
  slices: Object.fromEntries(targetNames.map((target) => [target, {
    packManifestSha256: sha256(join(packs[target].path, 'manifest.json')),
    fullMatrixFixtureEvidence: packs[target].manifest.fixtureEvidence?.fullMatrix === true,
  }])),
  files,
}
writeFileSync(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
mkdirSync(dirname(output), { recursive: true })
const finalVerifyArgs = [
  join(root, 'scripts', 'verify-ffmpeg-ios-xcframeworks.mjs'), '--pack', partial,
]
if (proofStaging) finalVerifyArgs.push('--proof-staging')
else finalVerifyArgs.push('--require-full')
execFileSync(process.execPath, finalVerifyArgs, {
  stdio: 'inherit',
  env: proofStaging ? { ...process.env, SINGZ_CODEC_TARGET_PROOF: '1' } : process.env,
})
if (!existsSync(output)) {
  renameSync(partial, output)
} else {
  rmSync(backup, { recursive: true, force: true })
  renameSync(output, backup)
  try {
    renameSync(partial, output)
    rmSync(backup, { recursive: true, force: false })
  } catch (error) {
    try {
      if (existsSync(output)) rmSync(output, { recursive: true, force: true })
      renameSync(backup, output)
    } catch (rollback) {
      throw new AggregateError([error, rollback], `Could not compose or restore ${output}`)
    }
    throw error
  } finally {
    rmSync(partial, { recursive: true, force: true })
  }
}
console.log(`Published iOS FFmpeg XCFrameworks: ${relative(root, output)}`)
