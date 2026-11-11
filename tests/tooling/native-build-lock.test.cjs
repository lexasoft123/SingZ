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

const ONE_SLOT = { env: { SINGZ_NATIVE_BUILD_SLOTS: '1' } }

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
  const owner = track(locks.acquireNativeBuildLock(root, 'parent agent', ONE_SLOT))
  const result = inChild(sibling, join(scratch, 'agent-b-temp'), `
    const locks = require(process.argv[1]);
    try { locks.acquireNativeBuildLock(process.argv[2], 'other agent', { env: { SINGZ_NATIVE_BUILD_SLOTS: '1' } }); }
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
  assert.equal(firstPath.stdout.trim(), locks.nativeBuildLockPath(root))
  assert.equal(firstPath.stdout.trim(), join(locks.gitCommonDirectory(root), 'singz-native-build.lock'))
  assert.equal(owner.path, join(locks.nativeBuildSlotsPath(root), 'slot-1'))
  assert.equal(owner.path, join(`${firstPath.stdout.trim()}.d`, 'slot-1'))
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
  const a = first.track(locks.acquireNativeBuildLock(first.root, 'first', ONE_SLOT))
  const b = second.track(locks.acquireNativeBuildLock(second.root, 'second', ONE_SLOT))
  assert.notEqual(a.path, b.path)
  a.release()
  a.release() // release is deliberately idempotent
  const next = first.track(locks.acquireNativeBuildLock(first.sibling, 'next', ONE_SLOT))
  assert.equal(next.path, a.path)
  assert.notEqual(next.token, a.token)
})

test('exported trees keep one local lock independent of agent temp roots', (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'singz-export-lock-test-')))
  const root = join(scratch, 'export')
  const otherRoot = join(scratch, 'another-export')
  mkdirSync(root)
  mkdirSync(otherRoot)
  const owner = locks.acquireNativeBuildLock(root, 'export build', ONE_SLOT)
  const other = locks.acquireNativeBuildLock(otherRoot, 'independent export build', ONE_SLOT)
  t.after(() => {
    owner.release()
    other.release()
    rmSync(scratch, { recursive: true, force: true })
  })
  assert.equal(locks.nativeBuildLockPath(root), join(root, '.singz-native-build.lock'))
  assert.equal(owner.path, join(root, '.singz-native-build.lock.d', 'slot-1'))
  assert.notEqual(owner.path, other.path)
  const result = inChild(root, join(scratch, 'worker-temp'), `
    const locks = require(process.argv[1]);
    try { locks.acquireNativeBuildLock(process.argv[2], 'worker', { env: { SINGZ_NATIVE_BUILD_SLOTS: '1' } }); }
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
  const lockPath = join(locks.nativeBuildSlotsPath(root), 'slot-1')
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
    rmSync(locks.nativeBuildSlotsPath(root), { recursive: true, force: true })
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

function startWrapper(wrapper, command, args = [], { flags = [], env = process.env } = {}) {
  const child = spawn(process.execPath, [wrapper, '--owner', 'fixture', ...flags, '--', command, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'], env,
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

// ---- Counting lock: parallel slots, exclusive mode, compatibility, reclaim ----

const FOUR = { env: { SINGZ_NATIVE_BUILD_SLOTS: '4' } }
const sleep = (ms) => new Promise(resolveWait => setTimeout(resolveWait, ms))

function slotDirectory(root, n) { return join(locks.nativeBuildSlotsPath(root), `slot-${n}`) }

/** Plant a lock directory as another process would have left it. */
function plantRecord(directory, record) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'owner.json'), JSON.stringify(record))
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(child.stdout)
}

function staleRecord(extra = {}) {
  return {
    format: 2, token: `planted-${randomHex()}`, pid: deadPid(), owner: 'planted',
    hostname: require('node:os').hostname(), repoIdentity: 'unused', checkout: '/unused',
    startedAt: new Date().toISOString(), ...extra,
  }
}
function randomHex() { return require('node:crypto').randomBytes(6).toString('hex') }

test('slot count defaults to four and clamps 1-4; garbage fails closed', () => {
  assert.equal(locks.nativeBuildSlotCount({}), 4)
  assert.equal(locks.nativeBuildSlotCount({ SINGZ_NATIVE_BUILD_SLOTS: '' }), 4)
  assert.equal(locks.nativeBuildSlotCount({ SINGZ_NATIVE_BUILD_SLOTS: '2' }), 2)
  assert.equal(locks.nativeBuildSlotCount({ SINGZ_NATIVE_BUILD_SLOTS: '9' }), 4)
  assert.equal(locks.nativeBuildSlotCount({ SINGZ_NATIVE_BUILD_SLOTS: '0' }), 1)
  assert.throws(() => locks.nativeBuildSlotCount({ SINGZ_NATIVE_BUILD_SLOTS: 'many' }), /SINGZ_NATIVE_BUILD_SLOTS/)
})

test('N holders from different worktrees run at once; the N+1-th waits for a release', async (t) => {
  const { root, sibling, track } = fixture(t)
  const holders = []
  for (let index = 0; index < 4; ++index)
    holders.push(track(locks.acquireNativeBuildLock(index % 2 ? sibling : root, `holder ${index}`, FOUR)))
  assert.deepEqual(holders.map(holder => holder.slot).sort(), [1, 2, 3, 4])
  assert.equal(new Set(holders.map(holder => holder.token)).size, 4)
  assert.throws(() => locks.acquireNativeBuildLock(root, 'fifth', FOUR), /slot\(s\) are busy/)

  let admitted = null
  const waiter = locks.acquireNativeBuildLockWait(sibling, 'fifth', { ...FOUR, pollMs: 10 })
    .then(handle => { admitted = track(handle); return handle })
  await sleep(150)
  assert.equal(admitted, null, 'the fifth build must wait while four slots are held')
  holders[2].release()
  const handle = await waiter
  assert.equal(handle.slot, holders[2].slot)
  // Every concurrent holder passes the producer assertion with its own token.
  for (const holder of [holders[0], holders[1], holders[3], handle])
    assert.equal(locks.assertNativeBuildLockHeld(root, holder.token).token, holder.token)
})

test('a lowered slot limit is honoured', (t) => {
  const { root, track } = fixture(t)
  const options = { env: { SINGZ_NATIVE_BUILD_SLOTS: '2' } }
  track(locks.acquireNativeBuildLock(root, 'one', options))
  track(locks.acquireNativeBuildLock(root, 'two', options))
  assert.throws(() => locks.acquireNativeBuildLock(root, 'three', options), /2 native build slot/)
})

test('exclusive mode waits for every slot, blocks new ones, and runs alone', async (t) => {
  const { root, sibling, track } = fixture(t)
  const first = track(locks.acquireNativeBuildLock(root, 'running one', FOUR))
  const second = track(locks.acquireNativeBuildLock(sibling, 'running two', FOUR))
  // Non-waiting exclusive attempt fails and leaves no claim behind.
  assert.throws(() => locks.acquireNativeBuildLock(root, 'exclusive now', { ...FOUR, exclusive: true }), /waiting for running builds/)
  assert.equal(existsSync(locks.nativeBuildLockPath(root)), false)

  let exclusive = null
  const waiter = locks.acquireNativeBuildLockWait(sibling, 'exclusive', { ...FOUR, exclusive: true, pollMs: 10 })
    .then(handle => { exclusive = track(handle); return handle })
  await sleep(100)
  assert.equal(exclusive, null)
  // The pending claim already keeps newcomers out, so the exclusive build
  // cannot be starved by a stream of ordinary builds.
  assert.throws(() => locks.acquireNativeBuildLock(root, 'latecomer', FOUR), /holds every slot/)
  // A claim that is still draining proves nothing to a producer.
  const claim = JSON.parse(readFileSync(join(locks.nativeBuildLockPath(root), 'owner.json'), 'utf8'))
  assert.equal(claim.draining, true)
  assert.throws(() => locks.assertNativeBuildLockHeld(root, claim.token), /does not own/)

  first.release()
  await sleep(60)
  assert.equal(exclusive, null, 'one remaining slot still blocks exclusivity')
  second.release()
  const handle = await waiter
  assert.equal(handle.exclusive, true)
  assert.equal(locks.assertNativeBuildLockHeld(root, handle.token, { exclusive: true }).exclusive, true)
  assert.throws(() => locks.acquireNativeBuildLock(root, 'during exclusive', FOUR), /holds every slot/)
  assert.throws(() => locks.acquireNativeBuildLock(root, 'second exclusive', { ...FOUR, exclusive: true }), /lock is held/)
  handle.release()
  track(locks.acquireNativeBuildLock(root, 'after exclusive', FOUR))
})

test('exclusive producers reject a plain slot token', (t) => {
  const { root, track } = fixture(t)
  const slot = track(locks.acquireNativeBuildLock(root, 'plain', FOUR))
  assert.equal(locks.assertNativeBuildLockHeld(root, slot.token).owner, 'plain')
  assert.throws(() => locks.assertNativeBuildLockHeld(root, slot.token, { exclusive: true }), /not exclusive/)
})

test('an old-format lock directory occupies every slot until it is gone', (t) => {
  const { root, sibling, track } = fixture(t)
  const legacy = locks.nativeBuildLockPath(root)
  // Exactly what the previous implementation wrote: format 1, no hostname.
  plantRecord(legacy, { format: 1, token: `old-${randomHex()}-token`, pid: process.pid, owner: 'old script',
    repoIdentity: locks.gitCommonDirectory(root), checkout: root, startedAt: new Date().toISOString() })
  t.after(() => rmSync(legacy, { recursive: true, force: true }))
  for (const checkout of [root, sibling])
    assert.throws(() => locks.acquireNativeBuildLock(checkout, 'new script', FOUR), /holds every slot.*old script/)
  assert.throws(() => locks.acquireNativeBuildLock(root, 'new exclusive', { ...FOUR, exclusive: true }), /old script/)
  // Old-format records are never reclaimed automatically, even with a dead pid.
  plantRecord(legacy, { format: 1, token: 'old-dead-pid-token-123', pid: deadPid(), owner: 'old crashed',
    repoIdentity: locks.gitCommonDirectory(root), checkout: root })
  assert.throws(() => locks.acquireNativeBuildLock(root, 'new script', FOUR), /old crashed/)
  // An old holder's own children still pass the assertion.
  assert.equal(locks.assertNativeBuildLockHeld(root, 'old-dead-pid-token-123').owner, 'old crashed')
  rmSync(legacy, { recursive: true })
  track(locks.acquireNativeBuildLock(root, 'new script', FOUR))
})

test('token and identity checks fail closed across slots', (t) => {
  const first = fixture(t)
  const second = fixture(t)
  const a = first.track(locks.acquireNativeBuildLock(first.root, 'a', FOUR))
  const b = first.track(locks.acquireNativeBuildLock(first.sibling, 'b', FOUR))
  assert.equal(locks.assertNativeBuildLockHeld(first.sibling, a.token).owner, 'a')
  assert.equal(locks.assertNativeBuildLockHeld(first.root, b.token).owner, 'b')
  assert.throws(() => locks.assertNativeBuildLockHeld(first.root, 'forged-token-long-enough'), /does not own/)
  assert.throws(() => locks.assertNativeBuildLockHeld(first.root, 'short'), /missing or malformed/)
  // A token from another repository's lock never validates here, and a
  // repository with nothing held reports that plainly.
  const other = second.track(locks.acquireNativeBuildLock(second.root, 'other repo', FOUR))
  assert.throws(() => locks.assertNativeBuildLockHeld(first.root, other.token), /does not own/)
  second.track(other)
  other.release()
  assert.throws(() => locks.assertNativeBuildLockHeld(second.root, other.token), /not held/)
  // Rewriting one slot's token breaks that holder's release, not the other's.
  const record = JSON.parse(readFileSync(join(a.path, 'owner.json'), 'utf8'))
  writeFileSync(join(a.path, 'owner.json'), JSON.stringify({ ...record, token: 'hijacked-token-long-enough' }))
  assert.throws(() => a.release(), /ownership changed/)
  assert.throws(() => locks.assertNativeBuildLockHeld(first.root, a.token), /does not own/)
  writeFileSync(join(a.path, 'owner.json'), JSON.stringify(record))
  b.release()
})

test('assert-native-build-lock.cjs accepts any slot and requires exclusivity on request', (t) => {
  const { root, track } = fixture(t)
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  copyFileSync(modulePath, join(scripts, 'native-build-lock.cjs'))
  copyFileSync(resolve(__dirname, '../../scripts/assert-native-build-lock.cjs'), join(scripts, 'assert-native-build-lock.cjs'))
  const run = (token, ...flags) => spawnSync(process.execPath, [join(scripts, 'assert-native-build-lock.cjs'), ...flags], {
    encoding: 'utf8', env: { ...process.env, SINGZ_NATIVE_BUILD_LOCK_HELD: token },
  })
  const slots = [1, 2, 3].map(index => track(locks.acquireNativeBuildLock(root, `slot ${index}`, FOUR)))
  for (const slot of slots) assert.equal(run(slot.token).status, 0, run(slot.token).stderr)
  assert.notEqual(run(slots[2].token, '--exclusive').status, 0)
  assert.notEqual(run('forged-token-long-enough').status, 0)
  for (const slot of slots) slot.release()
  const exclusive = track(locks.acquireNativeBuildLock(root, 'alone', { ...FOUR, exclusive: true }))
  assert.equal(run(exclusive.token, '--exclusive').status, 0)
})

test('wrapper runs four builds at once, queues the fifth, and exclusive runs alone', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, wrapper, groupPids } = wrapperFixture(t)
  const log = join(root, 'log')
  mkdirSync(log)
  // Each fixture build records start, blocks until released, then records end.
  const script = join(root, 'job.cjs')
  writeFileSync(script, `
    const fs = require('node:fs'), path = require('node:path');
    const [dir, name] = process.argv.slice(2);
    fs.writeFileSync(path.join(dir, name + '.started'), String(process.pid));
    const timer = setInterval(() => {
      if (fs.existsSync(path.join(dir, name + '.go'))) { clearInterval(timer); fs.writeFileSync(path.join(dir, name + '.done'), '1'); }
    }, 10);
  `)
  const env = { ...process.env, SINGZ_NATIVE_BUILD_SLOTS: '4' }
  const jobs = new Map()
  const start = (name, flags = []) => {
    const run = startWrapper(wrapper, process.execPath, [script, log, name], { flags, env })
    jobs.set(name, run)
    t.after(() => { try { process.kill(run.child.pid, 'SIGKILL') } catch { /* done */ } })
    return run
  }
  const started = (name) => existsSync(join(log, `${name}.started`))
  const release = (name) => writeFileSync(join(log, `${name}.go`), '1')
  for (const name of ['a', 'b', 'c', 'd']) start(name)
  await until(() => ['a', 'b', 'c', 'd'].every(started))
  const owners = ['slot-1', 'slot-2', 'slot-3', 'slot-4'].map(slot =>
    JSON.parse(readFileSync(join(locks.nativeBuildSlotsPath(root), slot, 'owner.json'), 'utf8')))
  for (const owner of owners) if (owner.processGroup) groupPids.push(owner.processGroup)
  assert.equal(new Set(owners.map(owner => owner.token)).size, 4)

  const fifth = start('e')
  await sleep(300)
  assert.equal(started('e'), false, 'the fifth build must queue behind four running builds')
  assert.match(fifth.diagnostics(), /Waiting for SingZ native build slot/)
  // The exclusive build claims the lock ahead of the queued ordinary build.
  const exclusive = start('x', ['--exclusive'])
  await until(() => existsSync(locks.nativeBuildLockPath(root)))
  release('a')
  await sleep(300)
  assert.equal(started('e'), false, 'a pending exclusive claim keeps later builds out')
  assert.equal(started('x'), false, 'the exclusive build waits for every running build')
  for (const name of ['b', 'c', 'd']) release(name)
  await until(() => started('x'))
  assert.equal(started('e'), false, 'nothing runs beside an exclusive build')
  const claim = JSON.parse(readFileSync(join(locks.nativeBuildLockPath(root), 'owner.json'), 'utf8'))
  assert.equal(claim.exclusive, true)
  assert.deepEqual(existsSync(locks.nativeBuildSlotsPath(root)) ?
    require('node:fs').readdirSync(locks.nativeBuildSlotsPath(root)) : [], [])
  release('x')
  await until(() => started('e'))
  release('e')
  for (const run of jobs.values()) assert.equal((await run.completed)[0], 0, run.diagnostics())
  assert.equal(existsSync(locks.nativeBuildLockPath(root)), false)
})

// ---- No automatic reclamation: dead holders cost a slot until freed by hand ----

const POSIX = { skip: process.platform === 'win32' }

function spawnOrphanGroup(t) {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  orphan.unref()
  t.after(() => { try { process.kill(-orphan.pid, 'SIGKILL') } catch { /* already gone */ } })
  return orphan
}
async function killGroup(orphan) {
  process.kill(-orphan.pid, 'SIGKILL')
  await until(() => { try { process.kill(-orphan.pid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
}

test('a slot whose wrapper was killed before its child was recorded is never taken by waiters', POSIX, async (t) => {
  const { root, wrapper, lockPath, groupPids } = wrapperFixture(t)
  // What SIGKILL between spawn() and the child-identity write leaves behind: a
  // dead wrapper, a record without child/group, and a build still running.
  const orphan = spawnOrphanGroup(t)
  groupPids.push(orphan.pid)
  plantRecord(lockPath, staleRecord())
  assert.throws(() => locks.acquireNativeBuildLock(root, 'waiter', ONE_SLOT), /busy/)
  const marker = join(root, 'waiter-started')
  const waiter = startWrapper(wrapper, process.execPath,
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1')`],
    { env: { ...process.env, SINGZ_NATIVE_BUILD_SLOTS: '1' } })
  t.after(() => { try { process.kill(waiter.child.pid, 'SIGKILL') } catch { /* done */ } })
  await sleep(1500)
  assert.equal(existsSync(marker), false, 'a second build must not start beside the orphaned one')
  assert.equal(existsSync(lockPath), true)
  assert.doesNotThrow(() => process.kill(-orphan.pid, 0), 'the orphaned build is still running')
  assert.match(waiter.diagnostics(), /wrapper pid \d+ gone/)
  assert.match(waiter.diagnostics(), /--release-stale/)
})

test('a missing or partial record is unknown, never stale, however old', (t) => {
  const { root } = fixture(t)
  const { utimesSync } = require('node:fs')
  const old = new Date(Date.now() - 3_600_000)
  const slot = slotDirectory(root, 1)
  const legacy = locks.nativeBuildLockPath(root)
  for (const [directory, content] of [[slot, null], [slot, '{"format": 2, "token": "tr'], [legacy, null], [legacy, '{"format"']]) {
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    if (content !== null) writeFileSync(join(directory, 'owner.json'), content)
    utimesSync(directory, old, old)
    const busy = { code: 'SINGZ_NATIVE_BUILD_BUSY' }
    assert.throws(() => locks.acquireNativeBuildLock(root, 'next', ONE_SLOT), busy)
    assert.throws(() => locks.acquireNativeBuildLock(root, 'next exclusive', { ...ONE_SLOT, exclusive: true }), busy)
    assert.equal(existsSync(directory), true, `${directory} (${content}) must be left alone`)
    assert.throws(() => locks.releaseStaleNativeBuildLock(root, directory === legacy ? 'exclusive' : 1), /Refusing.*unknown/)
    assert.equal(existsSync(directory), true)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('owner.json is replaced, never rewritten in place: the draining=false update is a rename', async (t) => {
  const { root, track } = fixture(t)
  const { readdirSync, statSync } = require('node:fs')
  const holder = track(locks.acquireNativeBuildLock(root, 'running', ONE_SLOT))
  const legacy = locks.nativeBuildLockPath(root)
  const waiting = locks.acquireNativeBuildLockWait(root, 'exclusive waiter', { ...ONE_SLOT, exclusive: true, pollMs: 20 })
  await until(() => existsSync(join(legacy, 'owner.json')))
  const drainingInode = statSync(join(legacy, 'owner.json')).ino
  assert.equal(JSON.parse(readFileSync(join(legacy, 'owner.json'), 'utf8')).draining, true)
  holder.release()
  const handle = track(await waiting)
  assert.equal(JSON.parse(readFileSync(join(legacy, 'owner.json'), 'utf8')).draining, false)
  // An in-place truncate+write keeps the inode and exposes a truncated file to
  // readers in between; a temp file renamed into place always changes it.
  assert.notEqual(statSync(join(legacy, 'owner.json')).ino, drainingInode)
  assert.deepEqual(readdirSync(handle.path), ['owner.json'], 'no temp file is left behind')
})

test('--release-stale refuses while the wrapper, group or child lives, and works once all are gone', POSIX, async (t) => {
  const { root, wrapper, lockPath } = wrapperFixture(t)
  const release = (...args) => spawnSync(process.execPath, [wrapper, '--release-stale', ...args], { encoding: 'utf8' })
  const orphan = spawnOrphanGroup(t)
  const refuses = (record, pattern) => {
    plantRecord(lockPath, record)
    const result = release('1')
    assert.notEqual(result.status, 0, result.stderr)
    assert.match(result.stderr, pattern)
    assert.equal(existsSync(lockPath), true, 'a refused release must leave the lock')
  }
  refuses(staleRecord({ pid: process.pid, childPid: orphan.pid, processGroup: orphan.pid }), /wrapper process \d+ is still running/)
  refuses(staleRecord({ childPid: deadPid(), processGroup: orphan.pid }), /process group \d+ still has processes/)
  refuses(staleRecord({ childPid: orphan.pid }), /build process \d+ is still running/)
  refuses(staleRecord({ childPid: orphan.pid, processGroup: orphan.pid, hostname: 'another-host' }), /another host/)
  refuses(staleRecord({ childPid: orphan.pid, processGroup: orphan.pid, format: 1 }), /complete format-2/)
  refuses(staleRecord(), /no build process recorded/)
  assert.notEqual(release('not-a-slot').status, 0)
  await killGroup(orphan)
  plantRecord(lockPath, staleRecord({ childPid: orphan.pid, processGroup: orphan.pid }))
  const done = release('1')
  assert.equal(done.status, 0, done.stderr)
  assert.equal(existsSync(lockPath), false)
  assert.equal(locks.acquireNativeBuildLock(root, 'next', ONE_SLOT).slot, 1)
  // A dead exclusive claim that never started a build can be freed too.
  rmSync(locks.nativeBuildSlotsPath(root), { recursive: true })
  plantRecord(locks.nativeBuildLockPath(root), staleRecord({ exclusive: true, draining: true }))
  assert.equal(release('exclusive').status, 0)
  assert.equal(existsSync(locks.nativeBuildLockPath(root)), false)
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`${signal} while waiting removes the pending exclusive claim`, POSIX, async (t) => {
    const { root, wrapper } = wrapperFixture(t)
    const holder = locks.acquireNativeBuildLock(root, 'running build', ONE_SLOT)
    t.after(() => holder.release())
    const waiter = startWrapper(wrapper, process.execPath, ['-e', 'process.exit(0)'],
      { flags: ['--exclusive'], env: { ...process.env, SINGZ_NATIVE_BUILD_SLOTS: '1' } })
    t.after(() => { try { process.kill(waiter.child.pid, 'SIGKILL') } catch { /* done */ } })
    const legacy = locks.nativeBuildLockPath(root)
    await until(() => existsSync(join(legacy, 'owner.json')))
    assert.equal(JSON.parse(readFileSync(join(legacy, 'owner.json'), 'utf8')).draining, true)
    process.kill(waiter.child.pid, signal)
    const [code] = await waiter.completed
    assert.notEqual(code, 0, waiter.diagnostics())
    assert.equal(existsSync(legacy), false, 'the cancelled wait must not leave its claim')
    assert.equal(existsSync(join(locks.nativeBuildSlotsPath(root), 'slot-1')), true, 'the running holder is untouched')
    // The slot stays usable: the next build is admitted as soon as it is freed.
    holder.release()
    assert.equal(locks.acquireNativeBuildLock(root, 'next', ONE_SLOT).slot, 1)
  })
}
