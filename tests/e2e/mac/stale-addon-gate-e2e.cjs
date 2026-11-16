// A launch whose capture addon does not match this checkout must refuse to
// start: exit 1 within seconds, the reason on stderr, no window (src/main/
// addon-startup-gate.ts). The stale addon is a SCRATCH manifest with a wrong
// source stamp, selected with SINGZ_CAPTURE_ADDON; build/ is never touched.
require('../../shared/watchdog.cjs').arm('stale-addon-gate-e2e')

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '../../..')
const target = `${process.platform}-${process.arch}`
const current = JSON.parse(fs.readFileSync(path.join(root, 'build/capture-runtime', target, 'current.json'), 'utf8'))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-stale-addon-'))
try {
  const staleStamp = 'f'.repeat(current.sourceStamp.length)
  assert.notEqual(staleStamp, current.sourceStamp)
  fs.writeFileSync(path.join(scratch, 'singz-capture.manifest.json'),
    JSON.stringify({ ...current, sourceStamp: staleStamp }))
  const launch = (extra) => {
    const started = Date.now()
    const run = spawnSync(require('electron'), [path.join(root, 'out/main/index.js')], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, SINGZ_CAPTURE_ADDON: path.join(scratch, 'singz-capture.node'),
        SINGZ_USERDATA_DIR: path.join(scratch, 'profile'), SINGZ_NO_SYNC: '1', SINGZ_MUTE: '1',
        SINGZ_E2E_HIDDEN: '1', ...extra }
    })
    return { run, seconds: (Date.now() - started) / 1000 }
  }
  const { run, seconds } = launch({})
  assert.equal(run.status, 1, `expected exit 1, got ${run.status} / ${run.signal}\n${run.stderr}`)
  assert.ok(seconds < 10, `refusal took ${seconds}s`)
  assert.match(run.stderr, /older or different checkout/)
  assert.ok(run.stderr.includes(`Addon fingerprint: ${staleStamp}`), 'addon fingerprint missing from stderr')
  assert.match(run.stderr, /Checkout fingerprint: [0-9a-f]{8,}/)
  assert.match(run.stderr, /npm run capture:addon -- /)
  assert.doesNotMatch(run.stderr, /\n\s+at .*:\d+/, 'stack trace leaked')
  console.log(`stale-addon-gate-e2e ok: exit 1 in ${seconds.toFixed(1)}s`)
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
