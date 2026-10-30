const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { configureXcodeCache } = require('../ccache-xcode-conf.js')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'singz ios cache '))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const conf = path.join(root, 'mobile/node_modules/react-native/scripts/xcode/ccache.conf')
  fs.mkdirSync(path.dirname(conf), { recursive: true })
  fs.writeFileSync(conf, 'sloppiness = pch_defines,modules,time_macros\ndepend_mode = true\n')
  return { root, conf }
}

test('Xcode ccache generation preserves RN settings and replaces its own block idempotently', t => {
  const { root, conf } = fixture(t)
  assert.equal(configureXcodeCache(root, {}).changed, true)
  const first = fs.readFileSync(conf, 'utf8')
  assert.ok(first.includes(`base_dir = ${root}`))
  assert.ok(first.includes('sloppiness = pch_defines,modules,time_macros'))
  assert.ok(first.includes('hash_dir = false\ncompiler_check = content'))
  assert.equal(configureXcodeCache(root, {}).changed, false)
  // Repair repeated legacy blocks without removing upstream configuration.
  fs.writeFileSync(conf, first + first.slice(first.indexOf('# >>> SingZ')))
  configureXcodeCache(root, {})
  assert.equal(fs.readFileSync(conf, 'utf8'), first)
})

test('explicit shared directory and capacity reach Xcode without machine configuration edits', t => {
  const { root, conf } = fixture(t)
  const cache = path.join(root, 'shared compiler cache')
  configureXcodeCache(root, { CCACHE_DIR: cache, CCACHE_MAXSIZE: '750M' })
  const generated = fs.readFileSync(conf, 'utf8')
  assert.ok(generated.includes(`cache_dir = ${cache}\nmax_size = 750M`))
  configureXcodeCache(root, {})
  const defaults = fs.readFileSync(conf, 'utf8')
  assert.ok(!defaults.includes('cache_dir ='))
  assert.ok(!defaults.includes('max_size ='))
})

test('invalid overrides and missing installed RN config fail before changing the file', t => {
  const { root, conf } = fixture(t)
  const before = fs.readFileSync(conf, 'utf8')
  assert.throws(() => configureXcodeCache(root, { CCACHE_DIR: '/cache\ninjected = true' }), /newline/)
  for (const size of ['invalid', '1G\nextra = true', '-1G'])
    assert.throws(() => configureXcodeCache(root, { CCACHE_MAXSIZE: size }), /CCACHE_MAXSIZE/)
  assert.equal(fs.readFileSync(conf, 'utf8'), before)
  fs.rmSync(conf)
  assert.throws(() => configureXcodeCache(root, {}), /ccache.conf is missing/)
  fs.rmSync(path.join(root, 'mobile/node_modules/react-native'), { recursive: true })
  assert.equal(configureXcodeCache(root, {}).skipped, true)
})

test('installed ccache accepts generated Xcode configuration with spaces in paths', t => {
  if (spawnSync('ccache', ['--version']).status !== 0) return t.skip('ccache not installed')
  const { root, conf } = fixture(t)
  configureXcodeCache(root, { CCACHE_MAXSIZE: '750M' })
  const result = spawnSync('ccache', ['--show-config'], {
    env: { ...process.env, CCACHE_CONFIGPATH: conf }, encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(`base_dir = ${root}`))
  assert.match(result.stdout, /compiler_check = content/)
  assert.match(result.stdout, /max_size = (?:750\.0 MB|750M|0\.7 GiB)/)
})
