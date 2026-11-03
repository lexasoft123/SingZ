#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const nativeMarkers = ['SingzTorrent', 'libtorrent', 'rutracker.org']
const scriptMarkers = ['Search RuTracker', 'rutracker.org', 'Reading file list: release']
const contains = (bytes, text) => bytes.includes(Buffer.from(text)) || bytes.includes(Buffer.from(text, 'utf16le'))
function assertTorrentContents({ flag, native, bundle, paths }, enabled) {
  if (String(flag) !== (enabled ? '1' : '0')) throw new Error('Built feature flag does not match distribution')
  if (enabled) {
    if (!contains(native, 'SingzTorrent') || !contains(bundle, 'Search RuTracker')) throw new Error('Internal build is missing its native engine or song-search UI')
  } else {
    for (const marker of nativeMarkers) if (contains(native, marker)) throw new Error('Store binary contains ' + marker)
    for (const marker of scriptMarkers) if (contains(bundle, marker)) throw new Error('Store bundle contains ' + marker)
    if (paths.some(p => /SingzTorrent|rutracker|singz-torrent/i.test(p))) throw new Error('Store app contains optional download resources')
  }
}
function verifyApp(app, enabled) {
  const info = path.join(app, 'Info.plist')
  const read = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, info], { encoding: 'utf8' }).trim()
  const paths = []
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name
      paths.push(relative)
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative + '/')
    }
  }
  walk(app)
  assertTorrentContents({ flag: read('SingzTorrentsEnabled'), paths,
    native: fs.readFileSync(path.join(app, read('CFBundleExecutable'))),
    bundle: fs.readFileSync(path.join(app, 'main.jsbundle')) }, enabled)
}
function verifyArtifact(input, enabled) {
  if (input.endsWith('.app')) return verifyApp(input, enabled)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-feature-proof-'))
  try {
    execFileSync('/usr/bin/unzip', ['-q', input, '-d', temp])
    const payload = path.join(temp, 'Payload')
    const apps = fs.readdirSync(payload).filter(name => name.endsWith('.app'))
    if (apps.length !== 1) throw new Error('Expected exactly one app in IPA')
    verifyApp(path.join(payload, apps[0]), enabled)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}
module.exports = { assertTorrentContents, verifyArtifact }
if (require.main === module) {
  const [input, flag] = process.argv.slice(2)
  if (!input || !['0', '1'].includes(flag)) throw new Error('Usage: verify-torrent-build.cjs <app-or-ipa> <0|1>')
  verifyArtifact(path.resolve(input), flag === '1')
  console.log('iOS optional download feature: ' + (flag === '1' ? 'included (internal)' : 'excluded (store)'))
}
