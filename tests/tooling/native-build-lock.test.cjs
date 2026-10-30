const assert = require('node:assert/strict')
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')
const { once } = require('node:events')

// The override lets the regression suite be run against a preserved old
// implementation without rewriting the shared checkout during a negative run.
const modulePath = process.env.SINGZ_TEST_LOCK_MODULE ||
  resolve(__dirname, '../../scripts/native-build-lock.cjs')
const locks = require(modulePath)

function fixture(t) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'singz-lock-test-')))
  const held = []
  t.after(() => {
    for (const owner of held.reverse()) owner.release()
    rmSync(scratch, { recursive: true, force: true })
  })
  const track = (owner) => { held.push(owner); return owner }
  const root = join(scratch, 'main')
  mkdirSync(root)
  // Git writes are confined to these disposable fixture repositories.
  const git = (args, input) => execFileSync('git', ['-C', root, ...args], {
    input, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
  git(['init', '-q'])
  const tree = git(['mktree'], '')
  const commit = git(['commit-tree', tree], 'fixture\n')
  git(['update-ref', 'HEAD', commit])
  const sibling = join(scratch, 'sibling')
  git(['worktree', 'add', '-q', '--detach', sibling, commit])
  return { scratch, root, sibling, track }
}

function inChild(root, temp, body) {
  mkdirSync(temp, { recursive: true })
  return spawnSync(process.execPath, ['-e', body, modulePath, root], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
  })
}

test('sibling worktrees contend even when agents have different temp roots', (t) => {
  const { scratch, root, sibling, track } = fixture(t)
  const owner = track(locks.acquireNativeBuildLock(root, 'parent agent'))
  const result = inChild(sibling, join(scratch, 'agent-b-temp'), `
    const locks = require(process.argv[1]);
    try { locks.acquireNativeBuildLock(process.argv[2], 'other agent'); }
    catch (error) {
      if (!error.message.includes('parent agent')) throw error;
      process.exit(0);
    }
    throw new Error('Both agents acquired the repository build lock');
  `)
  assert.equal(result.status, 0, result.stderr)
  const firstPath = inChild(root, join(scratch, 'agent-a-temp'),
    'console.log(require(process.argv[1]).nativeBuildLockPath(process.argv[2]))')
  const secondPath = inChild(sibling, join(scratch, 'agent-b-temp'),
    'console.log(require(process.argv[1]).nativeBuildLockPath(process.argv[2]))')
  assert.equal(firstPath.status, 0, firstPath.stderr)
  assert.equal(secondPath.status, 0, secondPath.stderr)
  assert.equal(firstPath.stdout.trim(), secondPath.stdout.trim())
  assert.equal(firstPath.stdout.trim(), owner.path)
  assert.equal(owner.path, join(locks.gitCommonDirectory(root), 'singz-native-build.lock'))
})

test('nested workers validate ownership across worktrees and reject forged tokens', (t) => {
  const { root, sibling, track } = fixture(t)
  const owner = track(locks.acquireNativeBuildLock(root, 'outer build'))
  assert.equal(locks.assertNativeBuildLockHeld(sibling, owner.token).owner, 'outer build')
  assert.throws(() => locks.assertNativeBuildLockHeld(sibling, 'wrong-token-long-enough'),
    /does not own/)
  assert.throws(() => locks.assertNativeBuildLockHeld(root, undefined), /missing or malformed/)
  const record = JSON.parse(readFileSync(join(owner.path, 'owner.json'), 'utf8'))
  writeFileSync(join(owner.path, 'owner.json'), JSON.stringify({ ...record, token: 'other owner' }))
  assert.throws(() => owner.release(), /ownership changed/)
  writeFileSync(join(owner.path, 'owner.json'), JSON.stringify(record))
})

test('release allows the next build and distinct repositories do not contend', (t) => {
  const first = fixture(t)
  const second = fixture(t)
  const a = first.track(locks.acquireNativeBuildLock(first.root, 'first'))
  const b = second.track(locks.acquireNativeBuildLock(second.root, 'second'))
  assert.notEqual(a.path, b.path)
  a.release()
  a.release() // release is deliberately idempotent
  const next = first.track(locks.acquireNativeBuildLock(first.sibling, 'next'))
  assert.equal(next.path, a.path)
  assert.notEqual(next.token, a.token)
})

test('exported trees keep one local lock independent of agent temp roots', (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'singz-export-lock-test-')))
  const root = join(scratch, 'export')
  const otherRoot = join(scratch, 'another-export')
  mkdirSync(root)
  mkdirSync(otherRoot)
  const owner = locks.acquireNativeBuildLock(root, 'export build')
  const other = locks.acquireNativeBuildLock(otherRoot, 'independent export build')
  t.after(() => {
    owner.release()
    other.release()
    rmSync(scratch, { recursive: true, force: true })
  })
  assert.equal(owner.path, join(root, '.singz-native-build.lock'))
  assert.notEqual(owner.path, other.path)
  const result = inChild(root, join(scratch, 'worker-temp'), `
    const locks = require(process.argv[1]);
    try { locks.acquireNativeBuildLock(process.argv[2], 'worker'); }
    catch (error) { process.exit(error.message.includes('export build') ? 0 : 2); }
    process.exit(1);
  `)
  assert.equal(result.status, 0, result.stderr)
})

function wrapperFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'singz-wrapper-test-')))
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  copyFileSync(modulePath, join(scripts, 'native-build-lock.cjs'))
  const wrapper = join(scripts, 'with-native-build-lock.mjs')
  copyFileSync(process.env.SINGZ_TEST_WRAPPER_MODULE ||
    resolve(__dirname, '../../scripts/with-native-build-lock.mjs'), wrapper)
  const lockPath = locks.nativeBuildLockPath(root)
  const groupPids = []
  const descendantPids = []
  t.after(() => {
    for (const pid of groupPids) {
      try { process.kill(-pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    for (const pid of descendantPids) {
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    // All fixture children were killed; these paths contain only test data.
    rmSync(lockPath, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  return { root, wrapper, lockPath, groupPids, descendantPids }
}

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for fixture process')
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
}

function startWrapper(wrapper, command, args = []) {
  const child = spawn(process.execPath, [wrapper, '--owner', 'fixture', '--', command, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const completed = once(child, 'exit')
  return { child, completed, diagnostics: () => stderr }
}

test('wrapper releases after successful completion and after spawn failure', async (t) => {
  const { root, wrapper, lockPath } = wrapperFixture(t)
  const success = startWrapper(wrapper, process.execPath, ['-e', 'process.exit(0)'])
  assert.equal((await success.completed)[0], 0, success.diagnostics())
  assert.equal(existsSync(lockPath), false)
  const failure = startWrapper(wrapper, join(root, 'missing-executable'))
  assert.notEqual((await failure.completed)[0], 0)
  assert.equal(existsSync(lockPath), false, failure.diagnostics())
})

function orphanFixture(root, stayAlive) {
  const ready = join(root, 'descendant-ready')
  const descendant = join(root, 'descendant.cjs')
  const direct = join(root, 'direct.cjs')
  writeFileSync(descendant, `
    process.on('SIGTERM', () => require('node:fs').writeFileSync(process.argv[2] + '.signaled', 'yes'));
    require('node:fs').writeFileSync(process.argv[2], String(process.pid));
    setInterval(() => {}, 1000);
  `)
  writeFileSync(direct, `
    const child = require('node:child_process').spawn(process.execPath,
      [${JSON.stringify(descendant)}, ${JSON.stringify(ready)}], { stdio: 'ignore' });
    child.unref();
    ${stayAlive ? 'setInterval(() => {}, 1000);' : ''}
  `)
  return { ready, direct }
}

test('wrapper forwards signals to the group and retains lock while a descendant survives', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, wrapper, lockPath, groupPids, descendantPids } = wrapperFixture(t)
  const { ready, direct } = orphanFixture(root, true)
  const run = startWrapper(wrapper, process.execPath, [direct])
  await until(() => existsSync(ready))
  const descendantPid = Number(readFileSync(ready, 'utf8'))
  descendantPids.push(descendantPid)
  const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))
  if (owner.processGroup) groupPids.push(owner.processGroup)
  process.kill(run.child.pid, 'SIGTERM')
  assert.notEqual((await run.completed)[0], 0)
  assert.doesNotThrow(() => process.kill(descendantPid, 0))
  assert.equal(existsSync(`${ready}.signaled`), true, 'Descendant did not receive forwarded SIGTERM')
  assert.equal(existsSync(lockPath), true, run.diagnostics())
  assert.match(run.diagnostics(), /lock retained/)
})

test('normal direct-child exit retains lock if it leaves an orphan subprocess', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, wrapper, lockPath, groupPids, descendantPids } = wrapperFixture(t)
  const { ready, direct } = orphanFixture(root, false)
  const run = startWrapper(wrapper, process.execPath, [direct])
  await until(() => existsSync(ready))
  descendantPids.push(Number(readFileSync(ready, 'utf8')))
  const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'))
  if (owner.processGroup) groupPids.push(owner.processGroup)
  assert.notEqual((await run.completed)[0], 0)
  assert.equal(existsSync(lockPath), true, run.diagnostics())
  assert.match(run.diagnostics(), /lock retained/)
})
