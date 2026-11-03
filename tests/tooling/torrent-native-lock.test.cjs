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

// Exercise Windows exec semantics on every CI host. Only os.execvp is replaced
// in a disposable Python launcher: it spawns the genuine owner without waiting,
// exactly the boundary that allowed dist to race the next native producer.
function windowsWaitFixture(t, producer, removeWait = false) {
  const f = fixture(t, producer)
  const scripts = join(f.root, 'scripts')
  const entry = join(scripts, producer.file)
  let script = readFileSync(entry, 'utf8')
  const indentation = producer.name === 'SDK' ? ' ' : ''
  script = replaceOnce(script, indentation + "if not os.environ.get('SINGZ_NATIVE_BUILD_LOCK_HELD'):",
    indentation + "sys.platform = 'win32'\n" + indentation + "if not os.environ.get('SINGZ_NATIVE_BUILD_LOCK_HELD'):")
  if (removeWait) {
    script = replaceOnce(script, 'sys.exit(subprocess.run(lock_command,check=False).returncode)',
      'os.execvp(lock_command[0],lock_command)')
  }
  writeFileSync(entry, script)
  const locks = join(scripts, 'native-build-lock.cjs')
  writeFileSync(locks, replaceOnce(readFileSync(locks, 'utf8'), '  process.exit(19);',
    '  setTimeout(() => process.exit(19), 300);'))
  const launcher = `
import os,subprocess,sys,runpy
from pathlib import Path
def nonwaiting_exec(command,args):
 subprocess.Popen(args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 os._exit(0)
os.execvp=nonwaiting_exec
sys.argv=${JSON.stringify([entry, ...producer.args])}
runpy.run_path(sys.argv[0],run_name='__main__')
`
  const env = { ...process.env }
  delete env.SINGZ_NATIVE_BUILD_LOCK_HELD
  return {
    ...f,
    run: () => spawnSync(python, ['-c', launcher], { cwd: f.root, env, encoding: 'utf8', timeout: 15_000 }),
    async stopped() {
      // The negative control intentionally leaves the real lock owner running.
      // Let its bounded probe retire before deleting the disposable checkout.
      const lockPath = require(locks).nativeBuildLockPath(f.root)
      const deadline = Date.now() + 5000
      while ((!existsSync(join(f.root, 'validated.json')) || existsSync(lockPath)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
      assert.equal(existsSync(lockPath), false, 'Windows fixture owner did not retire')
    }
  }
}

test('Windows Python entry points wait for their owner and propagate failure', async t => {
  for (const producer of cases.filter(p => p.command === python)) await t.test(producer.name, async t => {
    const f = windowsWaitFixture(t, producer)
    const result = f.run()
    assert.equal(existsSync(require(join(f.root, 'scripts/native-build-lock.cjs')).nativeBuildLockPath(f.root)), false, 'The Python caller returned before its owner released the lock')
    await f.stopped()
    assert.equal(result.status, 1, 'The lock owner failure must reach the original Python caller')
    f.validated(result, false)
  })
})

test('nonwaiting Windows exec loses the owner exit status', async t => {
  for (const producer of cases.filter(p => p.command === python)) await t.test(producer.name, async t => {
    const f = windowsWaitFixture(t, producer, true)
    const result = f.run()
    await f.stopped()
    assert.ifError(result.error)
    assert.equal(result.status, 0, 'The deliberate old boundary masks the owner failure')
    assert.throws(() => {
      assert.equal(result.status, 1, 'The lock owner failure must reach the original Python caller')
    }, /lock owner failure/)
    assert.equal(existsSync(join(f.root, 'validated.json')), true)
    assert.equal(existsSync(join(f.root, 'native-work')), false)
  })
})

test('Windows SDK captures x64 tools privately before downloads, after the lock guard', () => {
  const driver = String.raw`
import ntpath,runpy,subprocess,sys
from pathlib import Path
from unittest import mock
sdk=runpy.run_path(sys.argv[1],run_name='sdk_environment_fixture')
prepare=sdk['msvc_environment']
installation=r'C:\Program Files\Visual Studio Ж with spaces'
base={'Path':'initial','ProgramFiles(x86)':r'C:\Programme Ж','SystemRoot':r'C:\Windows','Fixture_Secret':'fixture-secret=never-print'}
selected='Path=toolchain Ж\r\nInclude=headers Ж\r\nLIB=libraries Ж\r\nVSCMD_ARG_TGT_ARCH=x64\r\nFixture_Secret=fixture-secret=never-print\r\n=C:=ignore drive pseudo-variable\r\n'
selected=selected.replace('\\r\\n','\r\n')
def which(name,path=None):
 return ntpath.join(r'C:\toolchain',name) if path=='toolchain Ж' and name in ('cl.exe','nmake.exe') else None
def capture(args,**options):
 assert options['env']['FIXTURE_SECRET']=='fixture-secret=never-print'
 if args[0].endswith('vswhere.exe'):
  assert '-utf8' in args and options['encoding']=='utf-8'
  return '\ufeff'+installation+'\r\n'
 assert '/u' in args and '/d' in args and '/v:off' in args
 assert args[-1]=='call %SINGZ_TORRENT_VCVARS_COMMAND% >nul && set'
 assert options['env']['SINGZ_TORRENT_VCVARS_COMMAND']=='"'+ntpath.join(installation,'VC','Auxiliary','Build','vcvars64.bat')+'"'
 assert options['stderr']==subprocess.PIPE
 return selected.encode('utf-16le')
with mock.patch.object(sdk['shutil'],'which',which),mock.patch.object(Path,'is_file',lambda _:True),mock.patch.object(subprocess,'check_output',capture):
 result=prepare(base)
 assert result['PATH']=='toolchain Ж' and result['INCLUDE']=='headers Ж' and result['LIB']=='libraries Ж'
 assert 'Path' not in result and not any(key.startswith('=') for key in result)
 assert result['FIXTURE_SECRET']=='fixture-secret=never-print'
 assert 'SINGZ_TORRENT_VCVARS_COMMAND' not in result
 # An existing x64 prompt does not run vcvars or expose its environment.
 with mock.patch.object(subprocess,'check_output',side_effect=AssertionError('active prompt recaptured')):
  assert prepare(result)==result
 # A misleading x86 prompt must be recaptured for the win32-x64 target.
 assert prepare({**result,'VSCMD_ARG_TGT_ARCH':'x86'})['VSCMD_ARG_TGT_ARCH']=='x64'
with mock.patch.object(sdk['shutil'],'which',lambda *a,**k:None),mock.patch.object(Path,'is_file',lambda _:False),mock.patch.object(subprocess,'check_output',side_effect=AssertionError('missing installer executed')):
 try:prepare(base)
 except RuntimeError as error:assert 'Build Tools' in str(error)
 else:raise AssertionError('Missing Visual Studio accepted')
# Never print malformed captured environment output, even in a failure.
def malformed(args,**options):
 return installation if args[0].endswith('vswhere.exe') else b'\xff'
with mock.patch.object(sdk['shutil'],'which',which),mock.patch.object(Path,'is_file',lambda _:True),mock.patch.object(subprocess,'check_output',malformed):
 try:prepare(base)
 except RuntimeError as error:assert str(error)=='Could not initialize the Visual Studio x64 environment for the torrent SDK.'
 else:raise AssertionError('Malformed environment accepted')
# Discovery is after the actual guard invocation and before any source download.
build=sdk['build'];events=[]
def guard(*args,**kwargs):events.append('guard')
def environment(*args):events.append('environment');return {}
def source(*args):events.append('source');raise RuntimeError('fixture source boundary')
with mock.patch.object(sdk['platform'],'system',lambda:'Windows'),mock.patch.dict(build.__globals__,{'run':guard,'msvc_environment':environment,'source':source}):
 try:build('win32-x64',4)
 except RuntimeError as error:assert str(error)=='fixture source boundary'
 assert events==['guard','environment','source']
print('MSVC fixture passed')
`
  const result = spawnSync(python, ['-c', driver, join(source, 'vendor-torrent.py')], {
    encoding: 'utf8', timeout: 15_000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'MSVC fixture passed')
  assert.equal(result.stderr, '')
})
