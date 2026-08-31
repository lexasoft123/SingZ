#!/usr/bin/env node
'use strict'

const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const {
  iosAudioHostCallbackFiles,
  nativePlaybackCallbackFiles,
  nativePlaybackSessionFiles,
  zcoreDeviceCallbackFiles,
  zdspHostAdapterFiles,
  zdspRuntimeFiles,
} = require('./native-component-sources')

const repoRoot = join(__dirname, '..', '..')

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

const targetSourceMembers = (text, target) => {
  return invocationTokenGroups(text, 'target_sources', target)
    .flatMap((tokens) => {
      if (tokens[0] !== target || tokens[1] !== 'PRIVATE') {
        throw new Error(`${target} target_sources is no longer PRIVATE`)
      }
      return tokens.slice(2)
    })
}

const setMembers = (text, variable) => {
  const groups = invocationTokenGroups(text, 'set', variable)
  if (groups.length !== 1) {
    throw new Error(`${variable} has more than one set declaration`)
  }
  const tokens = groups[0]
  if (tokens[0] !== variable) throw new Error(`invalid set(${variable})`)
  return tokens.slice(1).map((entry) =>
    entry.replace(/^\$\{CMAKE_CURRENT_SOURCE_DIR\}\//, '')
  )
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

const zdspCmake = readFileSync(join(repoRoot, 'zdsp', 'CMakeLists.txt'), 'utf8')
const zcoreCmake = readFileSync(join(repoRoot, 'zcore', 'CMakeLists.txt'), 'utf8')
const rootCmake = readFileSync(join(repoRoot, 'CMakeLists.txt'), 'utf8')

compareExact(
  'zdsp_runtime',
  addLibraryMembers(zdspCmake, 'zdsp_runtime').concat(
    targetSourceMembers(zdspCmake, 'zdsp_runtime')
  ),
  zdspRuntimeFiles
)
compareExact(
  'zdsp_host_adapter',
  addLibraryMembers(zdspCmake, 'zdsp_host_adapter').concat(
    targetSourceMembers(zdspCmake, 'zdsp_host_adapter')
  ),
  zdspHostAdapterFiles
)
compareExact(
  'zcore_device_callback',
  addLibraryMembers(zcoreCmake, 'zcore_device_callback').concat(
    targetSourceMembers(zcoreCmake, 'zcore_device_callback')
  ),
  zcoreDeviceCallbackFiles
)
compareExact(
  'iOS AudioHost callback',
  setMembers(zcoreCmake, 'SINGZ_IOS_AUDIO_HOST_RT_SOURCES'),
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

console.log('native-component-sources: CMake and iOS manifests match exactly')
