const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

const source = resolve(__dirname, '../../scripts')
const python = process.platform === 'win32' ? 'python' : 'python3'
const cases = [
  { name: 'SDK', file: 'vendor-torrent.py', command: python, args: ['ios-arm64'], owner: 'torrent-sdk:ios-arm64' },
  { name: 'iOS package', file: 'build-torrent-ios.py', command: python, args: ['--skip-build'], owner: 'torrent-ios' },
  { name: 'Electron addon', file: 'build-torrent-addon.cjs', command: process.execPath, args: [`${process.platform}-${process.arch}`], owner: `torrent-addon:${process.platform}-${process.arch}` },
]

function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length - 1, 1, 'Fixture injection no longer names one boundary')
  return text.replace(before, after)
}

function fixture(t, producer, removeGuard = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'singz torrent lock ')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  for (const file of ['native-build-lock.cjs', 'with-native-build-lock.mjs', 'assert-native-build-lock.cjs']) {
    copyFileSync(join(source, file), join(scripts, file))
  }
  // This is the real validator and wrapper, with genuine generated owner/token
  // records. Stop immediately AFTER successful validation, before any SDK work.
  const lockModule = join(scripts, 'native-build-lock.cjs')
  writeFileSync(lockModule, readFileSync(lockModule, 'utf8') + `
const realAssert = module.exports.assertNativeBuildLockHeld;
module.exports.assertNativeBuildLockHeld = (root, token) => {
  const record = realAssert(root, token);
  writeFileSync(join(root, 'validated.json'), JSON.stringify({ record, environmentToken: process.env.SINGZ_NATIVE_BUILD_LOCK_HELD }));
  process.exit(19);
};
`)
  // Loading the download helper must never touch Electron or the network.
  writeFileSync(join(scripts, 'build-capture-addon.cjs'), 'module.exports = {}\n')
  let script = readFileSync(join(source, producer.file), 'utf8')
  if (removeGuard) {
    // Deliberate negative control in the disposable copy, never the checkout.
    if (producer.command === python) {
      script = replaceOnce(script, "if not os.environ.get('SINGZ_NATIVE_BUILD_LOCK_HELD'):", 'if False:')
      const statement = producer.name === 'SDK'
        ? " run(['node',ROOT/'scripts/assert-native-build-lock.cjs'],cwd=ROOT)\n"
        : "run(['node',ROOT/'scripts/assert-native-build-lock.cjs'])\n"
      script = replaceOnce(script, statement, '')
    } else {
      script = replaceOnce(script, 'if (!process.env.SINGZ_NATIVE_BUILD_LOCK_HELD) {', 'if (false) {')
      script = replaceOnce(script, '  assertNativeBuildLockHeld(root, process.env.SINGZ_NATIVE_BUILD_LOCK_HELD)\n', '')
    }
  }
  // Fence the FIRST work boundary in each producer. Even the negative control
  // cannot start a download, compiler, SDK write, or packaging command.
  if (producer.name === 'SDK') {
    script = replaceOnce(script, 'def source(name):\n', "def source(name):\n (ROOT/'native-work').write_text('SDK work sentinel')\n raise RuntimeError('native work sentinel')\n")
  } else if (producer.name === 'iOS package') {
    script = replaceOnce(script, 'parts=[]\n', "(ROOT/'native-work').write_text('iOS work sentinel')\nraise RuntimeError('native work sentinel')\nparts=[]\n")
  } else {
    script = replaceOnce(script, 'async function main() {\n', "async function main() {\n  require('node:fs').writeFileSync(join(root, 'native-work'), 'addon work sentinel')\n  throw new Error('native work sentinel')\n")
  }
  const entry = join(scripts, producer.file)
  writeFileSync(entry, script)
  const launcher = join(scripts, 'nested-launcher.cjs')
  writeFileSync(launcher, `
const fs = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const root = require('node:path').resolve(__dirname, '..');
const locks = require('./native-build-lock.cjs');
const record = JSON.parse(fs.readFileSync(join(locks.nativeBuildLockPath(root), 'owner.json'), 'utf8'));
fs.writeFileSync(join(root, 'expected.json'), JSON.stringify({ record, environmentToken: process.env.SINGZ_NATIVE_BUILD_LOCK_HELD }));
const result = spawnSync(${JSON.stringify(producer.command)}, ${JSON.stringify([entry, ...producer.args])}, { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`)
  const locks = require(lockModule)
  const env = { ...process.env }
  delete env.SINGZ_NATIVE_BUILD_LOCK_HELD
  function run(nested) {
    const command = nested ? process.execPath : producer.command
    const args = nested
      ? [join(scripts, 'with-native-build-lock.mjs'), '--owner', 'outer fixture', '--', process.execPath, launcher]
      : [entry, ...producer.args]
    return spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 15_000 })
  }
  function validated(result, nested) {
    assert.ifError(result.error)
    assert.equal(result.signal, null, result.stderr)
    // The sentinel makes this diagnostic decisive even when all lock guards
    // were removed: a missing probe alone could be an unrelated startup error.
    assert.equal(existsSync(join(root, 'native-work')), false, 'Native work reached before lock validation')
    assert.ok(existsSync(join(root, 'validated.json')), result.stderr + result.stdout)
    const proof = JSON.parse(readFileSync(join(root, 'validated.json'), 'utf8'))
    assert.equal(proof.record.owner, nested ? 'outer fixture' : producer.owner)
    assert.equal(proof.environmentToken, proof.record.token)
    if (nested) {
      const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8'))
      assert.equal(proof.record.token, expected.record.token)
      assert.equal(proof.environmentToken, expected.environmentToken)
      assert.equal(proof.record.pid, expected.record.pid)
    }
    assert.equal(existsSync(locks.nativeBuildLockPath(root)), false, 'Completed producer retained its lock')
    assert.equal(existsSync(join(root, 'vendor')), false)
    assert.equal(existsSync(join(root, '.engines-src')), false)
  }
  return { root, run, validated }
}

test('torrent producers acquire a genuine lock before any native work', async t => {
  for (const producer of cases) await t.test(producer.name, t => {
    const f = fixture(t, producer)
    f.validated(f.run(false), false)
  })
})

test('nested torrent producers retain the existing owner and token', async t => {
  for (const producer of cases) await t.test(producer.name, t => {
    const f = fixture(t, producer)
    f.validated(f.run(true), true)
  })
})

test('removing the producer guards fails the native-work boundary check', async t => {
  for (const producer of cases) await t.test(producer.name, t => {
    const f = fixture(t, producer, true)
    const result = f.run(false)
    assert.throws(() => f.validated(result, false), /Native work reached before lock validation/)
    assert.equal(existsSync(join(f.root, 'validated.json')), false)
    assert.equal(existsSync(join(f.root, 'vendor')), false)
    assert.equal(existsSync(join(f.root, '.engines-src')), false)
  })
})
