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

test('a stale slot is reclaimed only once its owner and descendants are gone', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, track } = fixture(t)
  const slot = slotDirectory(root, 1)
  const options = { env: { SINGZ_NATIVE_BUILD_SLOTS: '1' } }
  const free = () => { try { locks.acquireNativeBuildLock(root, 'next', options).release(); return true } catch { return false } }
  const release = () => rmSync(locks.nativeBuildSlotsPath(root), { recursive: true, force: true })

  // Owner alive: kept.
  plantRecord(slot, staleRecord({ pid: process.pid }))
  assert.equal(free(), false)
  // Another host's record cannot be proven dead.
  plantRecord(slot, staleRecord({ hostname: 'some-other-host' }))
  assert.equal(free(), false)
  // An old-format record is not reclaimed.
  plantRecord(slot, staleRecord({ format: 1 }))
  assert.equal(free(), false)
  // Recorded child tree still running although the wrapper is gone: kept.
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  orphan.unref()
  t.after(() => { try { process.kill(-orphan.pid, 'SIGKILL') } catch { /* already gone */ } })
  plantRecord(slot, staleRecord({ childPid: orphan.pid, processGroup: orphan.pid }))
  assert.equal(free(), false)
  assert.equal(existsSync(slot), true)
  // The group exits: now owner and descendants are provably gone.
  process.kill(-orphan.pid, 'SIGKILL')
  await until(() => { try { process.kill(-orphan.pid, 0); return false } catch (error) { return error.code === 'ESRCH' } })
  assert.equal(free(), true)
  release()
  // A record with no child ever recorded and a dead owner is stale too.
  plantRecord(slot, staleRecord())
  assert.equal(free(), true)
  release()
  // An unrecorded directory is only reclaimed after the grace period.
  mkdirSync(slot, { recursive: true })
  assert.equal(free(), false)
  const { utimesSync } = require('node:fs')
  const old = new Date(Date.now() - 120_000)
  utimesSync(slot, old, old)
  assert.equal(free(), true)
})

test('a stale exclusive claim is reclaimed like a stale slot', (t) => {
  const { root, track } = fixture(t)
  plantRecord(locks.nativeBuildLockPath(root), staleRecord({ exclusive: true, draining: true }))
  const handle = track(locks.acquireNativeBuildLock(root, 'after crash', FOUR))
  assert.equal(handle.slot, 1)
  assert.equal(existsSync(locks.nativeBuildLockPath(root)), false)
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

// ---- Atomic reclamation (reclaimers and fresh claimants interleaved) ----

function liveRecord(root, extra = {}) {
  return {
    format: 2, token: `live-${randomHex()}-token`, pid: process.pid, owner: 'live',
    hostname: require('node:os').hostname(), repoIdentity: locks.gitCommonDirectory(root),
    checkout: root, startedAt: new Date().toISOString(), ...extra,
  }
}
function leftovers(root) {
  return require('node:fs').readdirSync(locks.nativeBuildSlotsPath(root))
    .filter(name => name !== 'slot-1')
}

test('two reclaimers and a fresh claimant never remove or hide a live slot', (t) => {
  const { root } = fixture(t)
  t.after(() => locks.setNativeBuildLockTestHooks({}))
  const slot = slotDirectory(root, 1)
  plantRecord(slot, staleRecord())
  let rival = 'not run', fresh = null
  locks.setNativeBuildLockTestHooks({
    // Reclaimer A has judged the slot stale and holds the reclaim mutex:
    // reclaimer B must not be able to act on the same directory.
    afterJudge() {
      try { locks.acquireNativeBuildLock(root, 'reclaimer B', ONE_SLOT).release(); rival = 'acquired' }
      catch (error) { rival = error.code }
      assert.equal(existsSync(slot), true, 'B must not touch the slot A is reclaiming')
    },
    // A has moved the stale directory away; the slot name is free for a
    // fresh claimant before A deletes the tombstone.
    afterRename() {
      locks.setNativeBuildLockTestHooks({})
      fresh = locks.acquireNativeBuildLock(root, 'fresh claimant', ONE_SLOT)
    },
  })
  assert.throws(() => locks.acquireNativeBuildLock(root, 'reclaimer A', ONE_SLOT), /busy/)
  assert.equal(rival, 'SINGZ_NATIVE_BUILD_BUSY')
  assert.ok(fresh, 'the fresh claimant takes the freed slot')
  assert.equal(JSON.parse(readFileSync(join(slot, 'owner.json'), 'utf8')).token, fresh.token)
  assert.equal(locks.assertNativeBuildLockHeld(root, fresh.token).owner, 'fresh claimant')
  assert.deepEqual(leftovers(root), [], 'no tombstone or reclaim mutex is left behind')
  fresh.release()
})

test('an owner that slips in after staleness was judged is put back, not deleted', (t) => {
  const { root } = fixture(t)
  t.after(() => locks.setNativeBuildLockTestHooks({}))
  const slot = slotDirectory(root, 1)
  plantRecord(slot, staleRecord())
  const live = liveRecord(root)
  locks.setNativeBuildLockTestHooks({
    afterJudge() {
      // Everything a late reclaimer cannot see: the stale directory is gone
      // and a live owner holds a brand new one.
      rmSync(slot, { recursive: true })
      plantRecord(slot, live)
    },
  })
  assert.throws(() => locks.acquireNativeBuildLock(root, 'reclaimer', ONE_SLOT), /busy/)
  assert.equal(JSON.parse(readFileSync(join(slot, 'owner.json'), 'utf8')).token, live.token)
  assert.equal(locks.assertNativeBuildLockHeld(root, live.token).owner, 'live')
  assert.deepEqual(leftovers(root), [])
})

test('if the live owner cannot be put back reclamation fails closed and keeps it', (t) => {
  const { root } = fixture(t)
  t.after(() => locks.setNativeBuildLockTestHooks({}))
  const slot = slotDirectory(root, 1)
  plantRecord(slot, staleRecord())
  const live = liveRecord(root)
  locks.setNativeBuildLockTestHooks({
    afterJudge() { rmSync(slot, { recursive: true }); plantRecord(slot, live) },
    afterRename() { plantRecord(slot, liveRecord(root, { owner: 'newer' })) },
  })
  assert.throws(() => locks.acquireNativeBuildLock(root, 'reclaimer', ONE_SLOT), /changed owner during reclamation/)
  const [tombstone] = leftovers(root).filter(name => name.includes('.reclaim-'))
  assert.ok(tombstone, 'the displaced live owner stays recoverable')
  assert.equal(JSON.parse(readFileSync(join(locks.nativeBuildSlotsPath(root), tombstone, 'owner.json'), 'utf8')).token, live.token)
})
