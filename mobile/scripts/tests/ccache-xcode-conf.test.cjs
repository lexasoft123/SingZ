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
  const wrappers = {}
  for (const compiler of ['clang', 'clang++']) {
    const file = path.join(path.dirname(conf), `ccache-${compiler}.sh`)
    const source = '#!/bin/sh\nREACT_NATIVE_CCACHE_CONFIGPATH="$(dirname "$0")/ccache.conf"\n' +
      'export CCACHE_CONFIGPATH="${CCACHE_CONFIGPATH:-$REACT_NATIVE_CCACHE_CONFIGPATH}"\n' +
      `exec $CCACHE_BINARY ${compiler} "$@"\n`
    fs.writeFileSync(file, source, { mode: 0o755 })
    wrappers[compiler] = file
  }
  return { root, conf, wrappers }
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


const posix = { skip: process.platform === 'win32' ? 'Xcode compiler wrappers require a POSIX shell' : false }
function executable(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\n' + source + '\n', { mode: 0o755 })
}
function compilerFixture(t) {
  const result = fixture(t)
  const tools = path.join(result.root, 'compiler tools')
  const ccache = path.join(result.root, "cache tool's folder", 'ccache')
  executable(ccache, 'printf "%s\\n" "$@" > "$SINGZ_CAPTURE"\nexec "$@"')
  for (const compiler of ['clang', 'clang++']) executable(path.join(tools, compiler),
    'printf "%s" "compiled fixture" > "$SINGZ_OBJECT"\nexit "${SINGZ_TEST_EXIT:-0}"')
  const env = { ...process.env, PATH: tools + path.delimiter + '/usr/bin:/bin',
    SINGZ_CAPTURE: path.join(result.root, 'cache-args'), SINGZ_OBJECT: path.join(result.root, 'object') }
  delete env.CCACHE_BINARY
  return { ...result, tools, ccache, env }
}

test('both Xcode wrappers invoke the configured cache without CCACHE_BINARY and preserve arguments/status', posix, t => {
  const f = compilerFixture(t)
  configureXcodeCache(f.root, { CCACHE_BINARY: f.ccache })
  for (const compiler of ['clang', 'clang++']) {
    const result = spawnSync('/bin/sh', [f.wrappers[compiler], '-DVALUE=space value', 'literal;argument'], { env: f.env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(f.env.SINGZ_CAPTURE, 'utf8').trimEnd().split('\n'),
      [compiler, '-DVALUE=space value', 'literal;argument'])
    assert.equal(fs.readFileSync(f.env.SINGZ_OBJECT, 'utf8'), 'compiled fixture')
    const failure = spawnSync('/bin/sh', [f.wrappers[compiler]], { env: { ...f.env, SINGZ_TEST_EXIT: '23' } })
    assert.equal(failure.status, 23)
  }
  assert.equal(configureXcodeCache(f.root, { CCACHE_BINARY: f.ccache }).changed, false)
  const override = path.join(f.root, 'override cache')
  executable(override, 'exit 31')
  assert.equal(spawnSync('/bin/sh', [f.wrappers.clang], { env: { ...f.env, CCACHE_BINARY: override } }).status, 31)
})

test('PATH discovery is embedded, optional absence compiles normally, and a lost configured cache fails', posix, t => {
  const f = compilerFixture(t)
  const discovered = configureXcodeCache(f.root, { PATH: path.dirname(f.ccache) })
  assert.equal(discovered.ccache, f.ccache)
  fs.rmSync(f.ccache)
  const unavailable = spawnSync('/bin/sh', [f.wrappers.clang], { env: f.env, encoding: 'utf8' })
  assert.equal(unavailable.status, 127)
  assert.match(unavailable.stderr, /configured ccache executable is unavailable/)
  assert.equal(fs.existsSync(f.env.SINGZ_OBJECT), false, 'configured cache failure must not silently invoke Clang')
  assert.equal(configureXcodeCache(f.root, { PATH: f.tools }).ccache, null)
  const optional = spawnSync('/bin/sh', [f.wrappers.clang], { env: f.env, encoding: 'utf8' })
  assert.equal(optional.status, 0, optional.stderr)
  assert.equal(fs.existsSync(f.env.SINGZ_OBJECT), true)
})

test('upstream wrapper drift and missing wrappers fail before any configuration or wrapper writes', t => {
  const f = fixture(t)
  const originalConf = fs.readFileSync(f.conf, 'utf8')
  const originalClang = fs.readFileSync(f.wrappers.clang, 'utf8')
  const originalCpp = fs.readFileSync(f.wrappers['clang++'], 'utf8')
  fs.writeFileSync(f.wrappers['clang++'], originalCpp.replace('exec $CCACHE_BINARY', 'exec changed-cache'))
  assert.throws(() => configureXcodeCache(f.root, { CCACHE_MAXSIZE: '700M' }), /wrapper changed upstream/)
  assert.equal(fs.readFileSync(f.conf, 'utf8'), originalConf)
  assert.equal(fs.readFileSync(f.wrappers.clang, 'utf8'), originalClang)
  fs.rmSync(f.wrappers['clang++'])
  assert.throws(() => configureXcodeCache(f.root, {}), /wrapper is missing/)
  assert.equal(fs.readFileSync(f.conf, 'utf8'), originalConf)
  fs.writeFileSync(f.wrappers['clang++'], originalCpp)
  configureXcodeCache(f.root, {})
  const currentConf = fs.readFileSync(f.conf, 'utf8')
  fs.writeFileSync(f.wrappers['clang++'], fs.readFileSync(f.wrappers['clang++'], 'utf8').replace('exit 127', 'exit 0'))
  assert.throws(() => configureXcodeCache(f.root, { CCACHE_MAXSIZE: '800M' }), /wrapper changed upstream/)
  assert.equal(fs.readFileSync(f.conf, 'utf8'), currentConf)
})


test('Objective-C module-cache paths retain their exact spelling and remain cache-key inputs', posix, t => {
  const f = compilerFixture(t)
  configureXcodeCache(f.root, { CCACHE_BINARY: f.ccache })
  const modulePath = '-fmodules-cache-path=' + path.join(f.root, 'DerivedData/ModuleCache.noindex')
  for (const language of ['objective-c', 'objective-c++', 'objective-c-header', 'objective-c++-header', 'c-header', 'c++-header']) {
    const result = spawnSync('/bin/sh', [f.wrappers.clang, '-x', language, modulePath, 'source path.m'], { env: f.env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(f.env.SINGZ_CAPTURE, 'utf8').trimEnd().split('\n'),
      ['clang', '-x', language, '--ccache-skip', modulePath, 'source path.m'])
  }
  for (const args of [
    ['-x', 'c++', '-include', 'prefix header.pch', modulePath],
    ['-x', 'c++', '-include-pch', 'prefix header', modulePath],
  ]) {
    const result = spawnSync('/bin/sh', [f.wrappers.clang, ...args], { env: f.env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(fs.readFileSync(f.env.SINGZ_CAPTURE, 'utf8').trimEnd().split('\n'),
      ['clang', ...args.slice(0, -1), '--ccache-skip', modulePath])
  }
  const forwarded = spawnSync('/bin/sh', [f.wrappers.clang, '-x', 'objective-c', '-Xclang', modulePath], { env: f.env, encoding: 'utf8' })
  assert.equal(forwarded.status, 0, forwarded.stderr)
  assert.deepEqual(fs.readFileSync(f.env.SINGZ_CAPTURE, 'utf8').trimEnd().split('\n'),
    ['clang', '-x', 'objective-c', '--ccache-skip', '-Xclang', '--ccache-skip', modulePath])
  const cpp = spawnSync('/bin/sh', [f.wrappers.clang, '-x', 'c++', modulePath, 'source.cpp'], { env: f.env, encoding: 'utf8' })
  assert.equal(cpp.status, 0, cpp.stderr)
  assert.deepEqual(fs.readFileSync(f.env.SINGZ_CAPTURE, 'utf8').trimEnd().split('\n'),
    ['clang', '-x', 'c++', modulePath, 'source.cpp'])
})
