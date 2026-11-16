const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

// Electron's node.lib imports N-API from node.exe, but the shipping host is
// electron.exe. A Windows addon without the delay-load hook loads fine in plain
// Node and kills the Electron process on require(), and CI only load-smokes
// the capture addon. Keep this contract visible for the torrent addon.
const torrentDir = resolve(__dirname, '../../native/torrent')

function windowsBlock(cmake) {
  const start = cmake.indexOf('elseif(WIN32)', cmake.indexOf('singz_torrent_addon'))
  assert.notEqual(start, -1, 'torrent addon has no WIN32 branch')
  return cmake.slice(start, cmake.indexOf('endif()', start))
}

function violations(cmake) {
  const block = windowsBlock(cmake)
  const found = []
  if (!/win_delay_load_hook\.cc/.test(block)) found.push('delay-load hook source')
  if (!/\/DELAYLOAD:node\.exe/.test(block)) found.push('/DELAYLOAD:node.exe')
  if (!/HOST_BINARY=\\"node\.exe\\"/.test(block)) found.push('HOST_BINARY definition')
  if (!/delayimp/.test(block)) found.push('delayimp')
  return found
}

test('Windows torrent addon delay-loads its node.exe import for Electron', () => {
  const cmake = readFileSync(join(torrentDir, 'CMakeLists.txt'), 'utf8')
  assert.deepEqual(violations(cmake), [])
  assert.ok(existsSync(join(torrentDir, '../electron/win_delay_load_hook.cc')))
})

test('the check rejects a torrent addon that links node.lib without the hook', () => {
  const cmake = readFileSync(join(torrentDir, 'CMakeLists.txt'), 'utf8')
  const old = cmake.replace(/ elseif\(WIN32\)[\s\S]*?\n endif\(\)/,
    ' elseif(WIN32)\n  target_link_libraries(singz_torrent_addon PRIVATE "${SINGZ_TORRENT_NODE_LIBRARY}")\n endif()')
  assert.notEqual(old, cmake, 'negative control did not change the source')
  assert.deepEqual(violations(old),
    ['delay-load hook source', '/DELAYLOAD:node.exe', 'HOST_BINARY definition', 'delayimp'])
})
