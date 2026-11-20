// Loads the built torrent addon inside the real Electron runtime and answers
// calls through it. A Windows addon that imports N-API from node.exe loads in
// plain Node but kills electron.exe on require(); the unit tests cannot see
// that, so every package build runs this against the file it ships.
//   electron tests/e2e/torrent-addon-smoke.cjs <path/to/singz-torrent.node>
require('../shared/watchdog.cjs').arm('torrent-addon-smoke')

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

assert.ok(process.versions.electron, 'smoke test must use the Electron runtime')
const app = process.env.ELECTRON_RUN_AS_NODE === '1' ? null : require('electron').app
const finish = (code) => (app ? app.exit(code) : process.exit(code))

const addonPath = resolve(process.argv[2] || '')
const roots = []
function root() {
  const dir = mkdtempSync(join(tmpdir(), 'singz-torrent-smoke-'))
  roots.push(dir)
  return dir
}
const call = async (addon, dir, op, release = '', index = 0, bytes) =>
  JSON.parse(await addon.request(dir, op, release, index, bytes))

async function run() {
  assert.ok(process.argv[2], 'usage: torrent-addon-smoke.cjs <singz-torrent.node>')
  assert.ok(existsSync(addonPath), 'addon not found: ' + addonPath)
  const addon = require(addonPath)
  const expected = createHash('sha256')
    .update(readFileSync(resolve(__dirname, '../../native/torrent/torrent_engine.cpp')))
    .digest('hex')
  assert.equal(addon.sourceStamp, expected, 'addon was built from different engine sources')

  const clean = root()
  assert.deepEqual(await call(addon, clean, 'queue'), { ok: true, data: { paused: false, downloads: [] } })
  assert.deepEqual(await call(addon, clean, 'status'), { ok: true, data: null })
  const garbage = await call(addon, clean, 'inspect', '12345', -1, Buffer.from('not a torrent'))
  assert.equal(garbage.ok, false, 'invalid metadata was accepted')
  assert.throws(() => addon.request(clean), /Expected root, operation, release and file index/)
  addon.shutdown(clean)

  // A corrupt saved queue must be quarantined, not leave the engine unusable.
  const corrupt = root()
  writeFileSync(join(corrupt, 'queue.bencode'), 'li2ee')
  assert.equal((await call(addon, corrupt, 'queue')).ok, true, 'corrupt queue made the engine unusable')
  assert.ok(existsSync(join(corrupt, 'queue.bencode.corrupt')), 'corrupt queue was not quarantined')
  addon.shutdown(corrupt)
  console.log('torrent addon smoke ok: ' + addonPath)
}

async function main() {
  let code = 0
  try {
    if (app) await app.whenReady()
    await run()
  } catch (error) {
    console.error(error && error.stack ? error.stack : error)
    code = 1
  }
  // Remove temp roots before exiting (app.exit() may not return), but never let
  // a transient Windows file lock decide the result.
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      console.warn('could not remove ' + dir + ': ' + (error && error.message))
    }
  }
  finish(code)
}
main()
