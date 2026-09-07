#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateFfmpegRuntimeBytes } from './ffmpeg-runtime-binary.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const [target, stageArgument] = process.argv.slice(2)
if (!target || !stageArgument)
  throw new Error('Usage: verify-staged-ffmpeg-codec-runtime.mjs <target> <stage>')
const stage = resolve(stageArgument)
const profile = JSON.parse(
  readFileSync(join(root, 'third_party', 'ffmpeg-codec', 'profile.json'), 'utf8'),
)
if (!profile.targets.includes(target)) throw new Error(`Unsupported FFmpeg target: ${target}`)

const configurationPath = join(stage, 'share', 'singz-ffmpeg', 'configuration.txt')
for (const path of [
  join(stage, 'include', 'libavcodec', 'avcodec.h'),
  join(stage, 'include', 'libavformat', 'avformat.h'),
  configurationPath,
]) {
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error(`Incomplete staged FFmpeg runtime: ${path}`)
}
const configuration = readFileSync(configurationPath, 'utf8').trim()
const options = new Set(configuration.split(/\s+/))
for (const forbidden of profile.forbiddenConfigureFlags) {
  if (configuration.includes(forbidden)) throw new Error(`Forbidden FFmpeg option: ${forbidden}`)
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
  if (!options.has(required)) throw new Error(`Staged FFmpeg is missing ${required}`)
}
const targetOptions = {
  'darwin-arm64': ['--target-os=darwin', '--arch=arm64'],
  'darwin-x64': ['--target-os=darwin', '--arch=x86_64'],
  'ios-arm64': ['--target-os=darwin', '--enable-cross-compile', '--arch=arm64'],
  'ios-simulator-arm64': ['--target-os=darwin', '--enable-cross-compile', '--arch=arm64'],
  'ios-simulator-x64': ['--target-os=darwin', '--enable-cross-compile', '--arch=x86_64'],
  'android-arm64-v8a': ['--target-os=android', '--enable-cross-compile', '--arch=aarch64'],
  'android-armeabi-v7a': ['--target-os=android', '--enable-cross-compile', '--arch=arm'],
  'android-x86': ['--target-os=android', '--enable-cross-compile', '--arch=x86'],
  'android-x86_64': ['--target-os=android', '--enable-cross-compile', '--arch=x86_64'],
  'win32-x64': ['--target-os=win64', '--arch=x86_64', '--toolchain=msvc'],
}[target]
for (const required of targetOptions) {
  if (!options.has(required)) throw new Error(`Staged FFmpeg target mismatch: missing ${required}`)
}
if (target === 'ios-arm64' && !configuration.includes('-miphoneos-version-min=15.1'))
  throw new Error('Staged iOS device runtime has the wrong deployment target')
if (target.startsWith('ios-simulator-') &&
    !configuration.includes('-mios-simulator-version-min=15.1'))
  throw new Error('Staged iOS simulator runtime has the wrong deployment target')
const androidCompilers = {
  'android-arm64-v8a': 'aarch64-linux-android21-clang',
  'android-armeabi-v7a': 'armv7a-linux-androideabi21-clang',
  'android-x86': 'i686-linux-android21-clang',
  'android-x86_64': 'x86_64-linux-android21-clang',
}
if (androidCompilers[target] && !configuration.includes(androidCompilers[target]))
  throw new Error(`Staged ${target} runtime has no Android API 21 compiler evidence`)
const major = profile.abiMajors
const candidates = {
  avcodec: target.startsWith('win32-')
    ? [`bin/avcodec-${major.avcodec}.dll`]
    : target.startsWith('android-') ? ['lib/libavcodec.so']
      : [`lib/libavcodec.${major.avcodec}.dylib`],
  avformat: target.startsWith('win32-')
    ? [`bin/avformat-${major.avformat}.dll`]
    : target.startsWith('android-') ? ['lib/libavformat.so']
      : [`lib/libavformat.${major.avformat}.dylib`],
  avutil: target.startsWith('win32-')
    ? [`bin/avutil-${major.avutil}.dll`]
    : target.startsWith('android-') ? ['lib/libavutil.so']
      : [`lib/libavutil.${major.avutil}.dylib`],
  swresample: target.startsWith('win32-')
    ? [`bin/swresample-${major.swresample}.dll`]
    : target.startsWith('android-') ? ['lib/libswresample.so']
      : [`lib/libswresample.${major.swresample}.dylib`],
}
for (const [component, paths] of Object.entries(candidates)) {
  const path = paths.map((candidate) => join(stage, candidate))
    .find((candidate) => existsSync(candidate))
  if (!path) throw new Error(`Staged FFmpeg has no ${component} runtime`)
  const bytes = readFileSync(path)
  validateFfmpegRuntimeBytes({ bytes, target, component, profile, path })
  if (component === 'avcodec' || component === 'avformat') {
    for (const alternatives of [
      ['--disable-everything'],
      [`--enable-demuxer=${profile.requiredDemuxers.join(',')}`,
       `--enable-demuxer='${profile.requiredDemuxers.join(',')}'`],
      [`--enable-decoder=${profile.requiredDecoders.join(',')}`,
       `--enable-decoder='${profile.requiredDecoders.join(',')}'`],
    ]) {
      if (!alternatives.some((token) => bytes.includes(Buffer.from(token))))
        throw new Error(`Staged ${component} does not contain ${alternatives[0]}`)
    }
  }
}
console.log(`Staged FFmpeg runtime verified: ${target}`)
