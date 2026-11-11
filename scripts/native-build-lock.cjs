const { randomBytes } = require('node:crypto')
const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { hostname } = require('node:os')
const { isAbsolute, join, resolve } = require('node:path')
const { execFileSync } = require('node:child_process')

/** Slots admitted at once. The owner's decision is 3-4 parallel native
 *  builds on this machine; SINGZ_NATIVE_BUILD_SLOTS lowers it (1-4). Every
 *  user of one repository's lock must agree on the value. */
const MAX_NATIVE_BUILD_SLOTS = 4
const SLOT_NAME = /^slot-[1-9][0-9]*$/
const RECORD_FORMAT = 2
// A claim directory with no readable owner.json this old died between mkdir
// and its first write; no child can exist yet because children start later.
const UNRECORDED_GRACE_MS = 30_000

/** The identity every worktree of one repository shares: its common git
 *  directory. An exported tree (a `git archive` unpacked on a field machine
 *  with no git at all — the Windows laptop) has none; there the tree's own
 *  root is the identity, which still serializes every build of THAT tree
 *  and is exactly as unique as the checkout it stands for. */
function gitCommonDirectory(repoRoot) {
  let value
  try {
    value = execFileSync(
      'git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim()
  } catch {
    try {
      value = execFileSync(
        'git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim()
    } catch (error) {
      // No git on the machine, or a tree git does not recognise as a
      // repository (exit 128 — an exported tree, and also a checkout whose
      // .git has gone bad, for which the tree's own root is still the only
      // identity anyone can serialize on). Anything else is a real failure
      // and stays one.
      if (error?.code === 'ENOENT' || error?.status === 128) return realpathSync(repoRoot)
      throw error
    }
  }
  const absolute = isAbsolute(value) ? value : resolve(repoRoot, value)
  return realpathSync(absolute)
}

function nativeBuildSlotCount(env = process.env) {
  const raw = env.SINGZ_NATIVE_BUILD_SLOTS
  if (raw === undefined || raw === '') return MAX_NATIVE_BUILD_SLOTS
  if (!/^[0-9]+$/.test(raw.trim()))
    throw new Error(`SINGZ_NATIVE_BUILD_SLOTS must be an integer from 1 through ${MAX_NATIVE_BUILD_SLOTS} (got ${raw})`)
  return Math.min(MAX_NATIVE_BUILD_SLOTS, Math.max(1, Number(raw)))
}

/** The pre-slot lock directory. It keeps two meanings: an old-format holder
 *  (every slot is occupied while it exists) and, for new code, an exclusive
 *  claim. Both make slot acquirers wait, and old scripts that only know this
 *  path fail fast against an exclusive holder. */
function nativeBuildLockPath(repoRoot) {
  const identity = gitCommonDirectory(repoRoot)
  // Keep the lock beside the shared repository metadata, not in os.tmpdir().
  // Workers deliberately use distinct TMPDIRs; hashing a common identity into
  // those different directories still creates independent, ineffective locks.
  // Preserve the canonical path's casing, including on Windows.
  const name = identity === realpathSync(repoRoot)
    ? '.singz-native-build.lock' // exported tree (or bare repository)
    : 'singz-native-build.lock'
  return join(identity, name)
}

/** Directory holding one `slot-<n>` directory per running shared build. */
function nativeBuildSlotsPath(repoRoot) {
  return `${nativeBuildLockPath(repoRoot)}.d`
}

class NativeBuildBusyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NativeBuildBusyError'
    this.code = 'SINGZ_NATIVE_BUILD_BUSY'
  }
}

function readRecord(directory) {
  try { return JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8')) } catch { return null }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

/** Whether a lock directory provably has no live owner or descendants. Anything
 *  that cannot be proven stays held: foreign hosts, old-format records, and
 *  Windows (Node cannot show a process tree has quiesced). */
function provenStale(directory) {
  const record = readRecord(directory)
  if (!record) {
    try { return Date.now() - statSync(directory).mtimeMs > UNRECORDED_GRACE_MS } catch { return false }
  }
  if (process.platform === 'win32' || !(record.format >= RECORD_FORMAT) || record.hostname !== hostname())
    return false
  if (processExists(record.pid)) return false
  if (record.processGroup && groupExists(record.processGroup)) return false
  if (record.childPid && !record.processGroup && processExists(record.childPid)) return false
  return true
}

/** Remove a provably stale lock directory. The rename makes the removal
 *  single-winner; the token is re-read from the renamed copy so a directory
 *  replaced after we judged it is put back rather than deleted. */
function reclaimIfStale(directory) {
  if (!existsSync(directory) || !provenStale(directory)) return false
  const judged = readRecord(directory)?.token ?? null
  const grave = `${directory}.reclaim-${process.pid}-${randomBytes(4).toString('hex')}`
  try { renameSync(directory, grave) } catch { return false }
  if ((readRecord(grave)?.token ?? null) !== judged) {
    try { renameSync(grave, directory) } catch { /* replaced again: leave the grave for inspection */ }
    return false
  }
  rmSync(grave, { recursive: true, force: true })
  return true
}

function occupiedSlots(slotsPath) {
  try { return readdirSync(slotsPath).filter(name => SLOT_NAME.test(name)) } catch { return [] }
}

function describeHolders(directories) {
  const parts = []
  for (const directory of directories) {
    let current = 'unreadable owner'
    try { current = readFileSync(join(directory, 'owner.json'), 'utf8').replace(/\s+/g, ' ').trim() } catch { /* diagnostic only */ }
    parts.push(`${directory}: ${current}`)
  }
  return parts.join('; ')
}

function writeRecord(directory, record) {
  writeFileSync(join(directory, 'owner.json'), `${JSON.stringify(record, null, 2)}\n`)
}

function makeHandle(path, token, extra) {
  let released = false
  return {
    path,
    token,
    ...extra,
    release() {
      if (released) return
      const record = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'))
      if (record.token !== token)
        throw new Error(`Native build lock ownership changed before release: ${path}`)
      rmSync(path, { recursive: true, force: false })
      released = true
    }
  }
}

function newToken() {
  return `${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`
}

/** One non-blocking admission attempt. Returns a handle, or null with the
 *  reason in `state.busy`. An exclusive attempt keeps its claim in `state`
 *  across calls so waiting does not lose its place to new slot holders.
 *
 *  Race argument: a slot taker looks for the legacy directory, creates its
 *  slot, then looks again; an exclusive claimer creates the legacy directory,
 *  then lists slots. Whichever mkdir came second sees the other's directory,
 *  so the two can never both proceed. */
function attempt(repoRoot, owner, options, state) {
  const exclusive = options.exclusive === true
  const legacy = nativeBuildLockPath(repoRoot)
  const slotsPath = nativeBuildSlotsPath(repoRoot)
  const identity = gitCommonDirectory(repoRoot)
  state.token ??= newToken()
  const base = () => ({
    format: RECORD_FORMAT, token: state.token, pid: process.pid, owner,
    hostname: hostname(), repoIdentity: identity, checkout: resolve(repoRoot),
    startedAt: new Date().toISOString()
  })

  if (exclusive) {
    if (!state.claimed) {
      try {
        mkdirSync(legacy)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        reclaimIfStale(legacy)
        state.busy = `the build lock is held (${describeHolders([legacy])})`
        return null
      }
      state.claimed = true
      try { writeRecord(legacy, { ...base(), exclusive: true, draining: true }) } catch (error) {
        rmSync(legacy, { recursive: true, force: true })
        state.claimed = false
        throw error
      }
    }
    // The claim already stops new slots; wait for running ones to finish.
    for (const name of occupiedSlots(slotsPath)) reclaimIfStale(join(slotsPath, name))
    const running = occupiedSlots(slotsPath)
    if (running.length) {
      state.busy = `waiting for running builds: ${describeHolders(running.map(name => join(slotsPath, name)))}`
      return null
    }
    writeRecord(legacy, { ...base(), exclusive: true, draining: false })
    return makeHandle(legacy, state.token, { exclusive: true, slot: null })
  }

  // An old-format holder, or an exclusive claim, occupies every slot.
  if (existsSync(legacy)) reclaimIfStale(legacy)
  if (existsSync(legacy)) {
    state.busy = `an exclusive or old-format build holds every slot (${describeHolders([legacy])})`
    return null
  }
  const limit = nativeBuildSlotCount(options.env ?? process.env)
  mkdirSync(slotsPath, { recursive: true })
  for (let n = 1; n <= limit; ++n) {
    const path = join(slotsPath, `slot-${n}`)
    try {
      mkdirSync(path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!reclaimIfStale(path)) continue
      try { mkdirSync(path) } catch (retry) { if (retry.code === 'EEXIST') continue; throw retry }
    }
    try {
      writeRecord(path, { ...base(), slot: n, exclusive: false })
    } catch (error) {
      rmSync(path, { recursive: true, force: true })
      throw error
    }
    if (existsSync(legacy)) {
      rmSync(path, { recursive: true, force: true })
      state.busy = `an exclusive or old-format build holds every slot (${describeHolders([legacy])})`
      return null
    }
    return makeHandle(path, state.token, { exclusive: false, slot: n })
  }
  const all = Array.from({ length: limit }, (_, index) => join(slotsPath, `slot-${index + 1}`))
  state.busy = `all ${limit} native build slot(s) are busy (${describeHolders(all)})`
  return null
}

function abandon(repoRoot, state) {
  if (!state.claimed) return
  const legacy = nativeBuildLockPath(repoRoot)
  if (readRecord(legacy)?.token === state.token) rmSync(legacy, { recursive: true, force: true })
  state.claimed = false
}

/** Take a slot (or, with `exclusive`, every slot) without waiting; throws a
 *  NativeBuildBusyError naming the holders when none is free. */
function acquireNativeBuildLock(repoRoot, owner, options = {}) {
  const state = {}
  const handle = attempt(repoRoot, owner, options, state)
  if (handle) return handle
  abandon(repoRoot, state)
  throw new NativeBuildBusyError(
    `Another or interrupted SingZ native build owns ${nativeBuildLockPath(repoRoot)}: ${state.busy}`)
}

/** Like acquireNativeBuildLock but waits, polling, until admitted. An
 *  exclusive waiter keeps its claim so later builds queue behind it. */
async function acquireNativeBuildLockWait(repoRoot, owner, options = {}) {
  const { pollMs = 500, reportMs = 30_000, onWait = () => {} } = options
  const state = {}
  let reported = -Infinity
  try {
    for (;;) {
      const handle = attempt(repoRoot, owner, options, state)
      if (handle) return handle
      if (Date.now() - reported >= reportMs) {
        reported = Date.now()
        onWait(`Waiting for SingZ native build ${options.exclusive ? 'exclusivity' : 'slot'}: ${state.busy}`)
      }
      await new Promise(resolveWait => setTimeout(resolveWait, pollMs))
    }
  } catch (error) {
    abandon(repoRoot, state)
    throw error
  }
}

/** The record proving `token` holds a slot (or the exclusive/old-format lock)
 *  of this repository (an exclusive one when `exclusive` is set; old-format
 *  holders never count as exclusive). A claim still waiting for slots to drain proves nothing. */
function assertNativeBuildLockHeld(repoRoot, token, { exclusive = false } = {}) {
  if (typeof token !== 'string' || token.length < 16)
    throw new Error('Native build lock token is missing or malformed')
  const legacy = nativeBuildLockPath(repoRoot)
  const slotsPath = nativeBuildSlotsPath(repoRoot)
  const directories = [legacy, ...occupiedSlots(slotsPath).map(name => join(slotsPath, name))]
  const records = directories.map(readRecord).filter(Boolean)
  if (!records.length) throw new Error(`Native build lock is not held at ${legacy}`)
  const identity = gitCommonDirectory(repoRoot)
  const record = records.find(candidate =>
    candidate.token === token && candidate.repoIdentity === identity && candidate.draining !== true)
  if (!record) throw new Error(`Native build lock token does not own ${legacy}`)
  if (exclusive && record.exclusive !== true)
    throw new Error(`Native build lock ${record.slot ? `slot ${record.slot}` : legacy} is not exclusive; rerun under with-native-build-lock.mjs --exclusive`)
  return record
}

module.exports = {
  MAX_NATIVE_BUILD_SLOTS,
  NativeBuildBusyError,
  acquireNativeBuildLock,
  acquireNativeBuildLockWait,
  assertNativeBuildLockHeld,
  gitCommonDirectory,
  nativeBuildLockPath,
  nativeBuildSlotCount,
  nativeBuildSlotsPath
}
