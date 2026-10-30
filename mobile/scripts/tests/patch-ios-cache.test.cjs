const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { patchIosCache } = require('../patch-ios-cache.cjs')

const originalPrepare = String.raw`  s.prepare_command = <<-CMD
    chmod +x scripts/download-prebuilt-binaries.sh
    #{prepare_command_prefix}scripts/download-prebuilt-binaries.sh ios #{skip_ffmpeg_argument}
  CMD`
const posixRuby = { skip: process.platform === 'win32' || spawnSync('ruby', ['--version']).status !== 0
  ? 'iOS prepare fixture requires Ruby and a POSIX shell' : false }
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-ios-pod-prepare-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, "repo's $unit path")
  const mobile = path.join(root, 'mobile')
  const dependency = path.join(mobile, 'node_modules/react-native-audio-api')
  const podspec = path.join(dependency, 'RNAudioAPI.podspec')
  const helper = path.join(root, 'scripts/restore-audio-api-prebuilts.cjs')
  fs.mkdirSync(dependency, { recursive: true })
  fs.mkdirSync(path.dirname(helper), { recursive: true })
  fs.writeFileSync(helper, `process.stdout.write(JSON.stringify({args: process.argv.slice(2), disabled: process.env.DISABLE_AUDIOAPI_STATIC_EXTERNAL_LIBS || ''}))\n`)
  fs.writeFileSync(podspec, originalPrepare)
  return { root, mobile, dependency, podspec, helper }
}

test('iOS prepare patch accepts only one pinned upstream shape and is idempotent', t => {
  const f = fixture(t)
  fs.writeFileSync(f.podspec, fs.readFileSync(f.podspec, 'utf8').replace(/\n/g, '\r\n'))
  assert.equal(patchIosCache(f.mobile), true)
  const patched = fs.readFileSync(f.podspec, 'utf8')
  assert.ok(patched.includes("node '../../../scripts/restore-audio-api-prebuilts.cjs' ios #{skip_ffmpeg_argument}"))
  assert.ok(!patched.includes('File.expand_path'))
  assert.ok(patched.includes('#{prepare_command_prefix}node'))
  assert.ok(!patched.includes('scripts/download-prebuilt-binaries.sh ios'))
  assert.equal(patchIosCache(f.mobile), false)
  assert.equal(fs.readFileSync(f.podspec, 'utf8'), patched)
})

test('upstream drift, duplicate prepare blocks, and missing helper fail without edits', t => {
  const f = fixture(t)
  for (const source of [originalPrepare.replace(' ios ', ' macos '), originalPrepare + '\n' + originalPrepare, originalPrepare + "\ns.prepare_command = 'other downloader'\n"]) {
    fs.writeFileSync(f.podspec, source)
    assert.throws(() => patchIosCache(f.mobile), /changed upstream/)
    assert.equal(fs.readFileSync(f.podspec, 'utf8'), source)
  }
  fs.writeFileSync(f.podspec, originalPrepare)
  fs.rmSync(f.helper)
  assert.throws(() => patchIosCache(f.mobile), /helper.*missing/)
  assert.equal(fs.readFileSync(f.podspec, 'utf8'), originalPrepare)
})

test('patched Ruby prepare command stays checkout-independent and preserves disabled features', posixRuby, t => {
  const f = fixture(t)
  const second = fixture(t)
  patchIosCache(f.mobile)
  patchIosCache(second.mobile)
  const patched = fs.readFileSync(f.podspec, 'utf8')
  assert.equal(fs.readFileSync(second.podspec, 'utf8'), patched)
  const rubySource = `require 'ostruct'\ns = OpenStruct.new\nprepare_command_prefix = 'DISABLE_AUDIOAPI_STATIC_EXTERNAL_LIBS=1 '\nskip_ffmpeg_argument = 'skipffmpeg'\n` + patched + '\nprint s.prepare_command\n'
  fs.writeFileSync(f.podspec, rubySource)
  fs.writeFileSync(second.podspec, rubySource)
  const ruby = spawnSync('ruby', [f.podspec], { cwd: os.tmpdir(), encoding: 'utf8' })
  const otherRuby = spawnSync('ruby', [second.podspec], { cwd: os.tmpdir(), encoding: 'utf8' })
  assert.equal(ruby.status, 0, ruby.stderr)
  assert.equal(otherRuby.status, 0, otherRuby.stderr)
  assert.equal(otherRuby.stdout, ruby.stdout, 'rendered prepare metadata must be identical across checkout paths')
  assert.ok(!ruby.stdout.includes(f.root) && !ruby.stdout.includes(second.root))
  assert.ok(ruby.stdout.includes('node '))
  const prepare = spawnSync('/bin/sh', ['-c', ruby.stdout], { cwd: f.dependency, encoding: 'utf8' })
  assert.equal(prepare.status, 0, prepare.stderr)
  assert.deepEqual(JSON.parse(prepare.stdout), { args: ['ios', 'skipffmpeg'], disabled: '1' })
  // The podspec must refuse a lost repo helper instead of falling back to curl.
  fs.rmSync(f.helper)
  const missing = spawnSync('ruby', [f.podspec], { encoding: 'utf8' })
  assert.equal(missing.status, 0, missing.stderr)
  const refused = spawnSync('/bin/sh', ['-c', missing.stdout], { cwd: f.dependency, encoding: 'utf8' })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /cache helper is missing/)
})
