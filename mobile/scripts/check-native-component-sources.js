#!/usr/bin/env node
'use strict'

const { readFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const {
  iosAudioHostCallbackFiles,
  nativePlaybackCallbackFiles,
  nativePlaybackSessionFiles,
  signalsmithTimePitchFiles,
  zcoreDeviceCallbackFiles,
  zdspHostAdapterFiles,
  zdspRuntimeFiles,
} = require('./native-component-sources')

const repoRoot = join(__dirname, '..', '..')
const audioEngineRoot = join(repoRoot, 'third_party', 'audio-engine')

execFileSync(process.execPath, [
  join(__dirname, 'verify-audio-engine-pin.js'),
], { stdio: 'inherit' })

const invocationTokenGroups = (text, command, firstArgument) => {
  const pattern = new RegExp(
    `${command}\\s*\\(\\s*${firstArgument}\\b`,
    'g'
  )
  const groups = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    const open = text.indexOf('(', match.index)
    let depth = 0
    let close = -1
    for (let index = open; index < text.length; ++index) {
      if (text[index] === '(') ++depth
      else if (text[index] === ')' && --depth === 0) {
        close = index
        break
      }
    }
    if (close < 0) {
      throw new Error(`unterminated ${command}(${firstArgument})`)
    }
    const body = text
      .slice(open + 1, close)
      .replace(/#[^\n\r]*/g, '')
    groups.push((body.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [])
      .map((token) => token.replace(/^["']|["']$/g, '')))
    pattern.lastIndex = close + 1
  }
  if (groups.length === 0) {
    throw new Error(`missing ${command}(${firstArgument} ...)`)
  }
  return groups
}

const addLibraryMembers = (text, target) => {
  const groups = invocationTokenGroups(text, 'add_library', target)
  if (groups.length !== 1) {
    throw new Error(`${target} has more than one add_library declaration`)
  }
  const tokens = groups[0]
  if (tokens[0] !== target || tokens[1] !== 'STATIC') {
    throw new Error(`${target} is no longer a plain STATIC target`)
  }
  return tokens.slice(2).filter((token) => token !== 'EXCLUDE_FROM_ALL')
}

const normalized = (entries, label) => {
  const clean = entries.map((entry) => entry.replaceAll('\\', '/'))
  if (new Set(clean).size !== clean.length) {
    throw new Error(`${label} contains duplicate source entries`)
  }
  return clean.sort()
}

const compareExact = (label, cmakeEntries, iosEntries) => {
  const cmake = normalized(cmakeEntries, `${label} CMake`)
  const ios = normalized(iosEntries, `${label} iOS manifest`)
  const cmakeSet = new Set(cmake)
  const iosSet = new Set(ios)
  const missing = cmake.filter((entry) => !iosSet.has(entry))
  const extra = ios.filter((entry) => !cmakeSet.has(entry))
  if (missing.length || extra.length) {
    throw new Error(
      `${label} source drift` +
      `${missing.length ? `; missing from iOS: ${missing.join(', ')}` : ''}` +
      `${extra.length ? `; extra in iOS: ${extra.join(', ')}` : ''}`
    )
  }
}

const rootCmake = readFileSync(join(repoRoot, 'CMakeLists.txt'), 'utf8')
const thirdPartyCmake = readFileSync(
  join(repoRoot, 'third_party', 'native', 'CMakeLists.txt'), 'utf8')

const audiozManifest = JSON.parse(readFileSync(
  join(audioEngineRoot, 'audioz-source-manifest.json'), 'utf8'))
const sourcePaths = new Set(audiozManifest.paths)
const componentFiles = (name) => {
  const entries = audiozManifest.components?.[name]
  if (!Array.isArray(entries)) throw new Error(`AudioZ manifest is missing ${name}`)
  const missing = entries.filter((entry) => !sourcePaths.has(entry))
  if (missing.length) {
    throw new Error(`${name} references paths absent from AudioZ manifest: ${missing.join(', ')}`)
  }
  return entries.map((entry) => entry.replace(/^(?:zcore|zdsp)\//, ''))
}
for (const entry of audiozManifest.iosCallbackGroup || []) {
  if (!sourcePaths.has(entry)) {
    throw new Error(`iOS callback group references a path absent from AudioZ manifest: ${entry}`)
  }
}

compareExact(
  'zdsp_runtime',
  componentFiles('zdsp_runtime'),
  zdspRuntimeFiles
)
compareExact(
  'zdsp_host_adapter',
  componentFiles('zdsp_host_adapter'),
  zdspHostAdapterFiles
)
compareExact(
  'zcore_device_callback',
  componentFiles('zcore_device_callback'),
  zcoreDeviceCallbackFiles
)
compareExact(
  'iOS AudioHost callback',
  (audiozManifest.iosCallbackGroup || []).map((entry) => entry.replace(/^zcore\//, '')),
  iosAudioHostCallbackFiles
)
compareExact(
  'native playback callback',
  addLibraryMembers(rootCmake, 'singz_native_playback_callback')
    .map((entry) => entry.replace(/^native\//, '')),
  nativePlaybackCallbackFiles
)
compareExact(
  'native playback session',
  addLibraryMembers(rootCmake, 'singz_native_playback_session')
    .map((entry) => entry.replace(/^native\//, '')),
  nativePlaybackSessionFiles
)
compareExact(
  'Signalsmith time/pitch wrapper',
  addLibraryMembers(thirdPartyCmake, 'singz_signalsmith_time_pitch')
    .map((entry) => entry.replace(/^\$\{SINGZ_REPO_ROOT\}\/native\//, '')),
  signalsmithTimePitchFiles
)

console.log('native-component-sources: AudioZ ownership and iOS manifests match exactly')
