const { randomBytes } = require('node:crypto')
const {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync
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
// There is deliberately NO automatic reclamation. A holder that died costs one
// slot until a human runs `with-native-build-lock.mjs --release-stale`, because
// a lock that frees itself on a guess can overlap a live build (a child started
// but not yet recorded, a record mid-rewrite, a reclaimer paused mid-step).

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

/** What a holder's record says about its processes, for diagnostics and for
 *  `--release-stale`. `complete` means the record is a readable format-2 record
 *  with the fields needed to prove the owner stopped. */
function holderState(directory) {
  const record = readRecord(directory)
  if (!record) return { record: null, complete: false }
  const complete = record.format >= RECORD_FORMAT && typeof record.token === 'string' &&
    Number.isInteger(record.pid) && typeof record.hostname === 'string'
  const sameHost = record.hostname === hostname()
  return {
    record, complete, sameHost,
    wrapperGone: complete && sameHost ? !processExists(record.pid) : null,
    groupGone: record.processGroup && sameHost ? !groupExists(record.processGroup) : null,
    childGone: record.childPid && sameHost ? !processExists(record.childPid) : null
  }
}

/** Why `directory` may NOT be freed by hand, or null when every process it
 *  recorded is provably gone. Fails closed: anything unprovable refuses. */
function releaseRefusal(directory) {
  const state = holderState(directory)
  const { record } = state
  if (!record) return 'its owner.json is missing or unreadable, so its owner is unknown'
  if (process.platform === 'win32') return 'Node cannot prove a Windows process tree has stopped'
  if (!state.complete) return 'its record is not a complete format-2 record (old-format holders cannot be verified)'
  if (!state.sameHost) return `it was recorded on another host (${record.hostname})`
  if (!state.wrapperGone) return `its wrapper process ${record.pid} is still running`
  if (record.processGroup && !state.groupGone) return `its process group ${record.processGroup} still has processes`
  if (record.childPid && !state.childGone) return `its build process ${record.childPid} is still running`
  // A draining exclusive claim has not started any build. Otherwise the record
  // must show the build's identity: without it a started child cannot be ruled out.
  if (record.draining !== true && !record.childPid)
    return 'its record has no build process recorded, so a started build cannot be ruled out; inspect it and remove the directory by hand'
  return null
}

/** Whether `path` exists. Only ENOENT means "no"; an unreadable parent or any
 *  other error throws, so an unknowable state is never taken for absence. */
function pathExists(path) {
  try { lstatSync(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/** The slot directories present. Only a missing slots directory (ENOENT) means
 *  "no slots"; EACCES or any other error throws so callers fail closed rather
 *  than treat live holders as absent. */
function occupiedSlots(slotsPath) {
  try { return readdirSync(slotsPath).filter(name => SLOT_NAME.test(name)) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function describeHolder(directory, label) {
  const state = holderState(directory)
  const { record } = state
  if (!record) return `${label}: record unknown (missing or unreadable; never freed automatically)`
  const tag = (gone) => gone === null ? 'unverifiable' : gone ? 'gone' : 'alive'
  const parts = [`owner "${record.owner}"`, `wrapper pid ${record.pid} ${tag(state.wrapperGone)}`]
  if (record.processGroup) parts.push(`group ${record.processGroup} ${tag(state.groupGone)}`)
  if (record.childPid) parts.push(`child ${record.childPid} ${tag(state.childGone)}`)
  if (record.hostname && !state.sameHost) parts.push(`host ${record.hostname}`)
  return `${label}: ${parts.join(', ')}`
}

/** One line per holder, plus the manual command when any might be dead. */
function describeHolders(entries) {
  const lines = entries.map(({ directory, label }) => describeHolder(directory, label))
  const dead = entries.some(({ directory }) => holderState(directory).wrapperGone === true)
  const hint = dead
    ? ' | a holder whose wrapper is gone costs a slot until freed by hand after verifying it stopped: node scripts/with-native-build-lock.mjs --release-stale <slot-number|exclusive>'
    : ''
  return `${lines.join('; ')}${hint}`
}

/** Publish `record` as `directory/owner.json` so readers see the old record or
 *  the new one, never a truncated file: write a temp file in the same
 *  directory, fsync it, rename over the target. */
function writeRecord(directory, record) {
  const target = join(directory, 'owner.json')
  const temp = join(directory, `owner.json.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  const fd = openSync(temp, 'wx')
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    rmSync(temp, { force: true })
    throw error
  }
  closeSync(fd)
  try { renameSync(temp, target) } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/** Merge `patch` into the record this handle owns (atomically). */
function updateNativeBuildLockRecord(handle, patch) {
  const record = readRecord(handle.path)
  if (!record || record.token !== handle.token)
    throw new Error(`Native build lock ownership changed before update: ${handle.path}`)
  writeRecord(handle.path, { ...record, ...patch })
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
        state.busy = `the build lock is held (${describeHolders([{ directory: legacy, label: 'exclusive/old-format' }])})`
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
    const running = occupiedSlots(slotsPath)
    if (running.length) {
      state.busy = `waiting for running builds: ${describeHolders(running.map(name => ({ directory: join(slotsPath, name), label: name })))}`
      return null
    }
    writeRecord(legacy, { ...base(), exclusive: true, draining: false })
    return makeHandle(legacy, state.token, { exclusive: true, slot: null })
  }

  // An old-format holder, or an exclusive claim, occupies every slot.
  if (pathExists(legacy)) {
    state.busy = `an exclusive or old-format build holds every slot (${describeHolders([{ directory: legacy, label: 'exclusive/old-format' }])})`
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
      continue
    }
    try {
      writeRecord(path, { ...base(), slot: n, exclusive: false })
    } catch (error) {
      rmSync(path, { recursive: true, force: true })
      throw error
    }
    let claimed
    try { claimed = pathExists(legacy) } catch (error) {
      rmSync(path, { recursive: true, force: true })
      throw error
    }
    if (claimed) {
      rmSync(path, { recursive: true, force: true })
      state.busy = `an exclusive or old-format build holds every slot (${describeHolders([{ directory: legacy, label: 'exclusive/old-format' }])})`
      return null
    }
    return makeHandle(path, state.token, { exclusive: false, slot: n })
  }
  const all = Array.from({ length: limit }, (_, index) =>
    ({ directory: join(slotsPath, `slot-${index + 1}`), label: `slot-${index + 1}` }))
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
  let handle
  try { handle = attempt(repoRoot, owner, options, state) } catch (error) {
    abandon(repoRoot, state)
    throw error
  }
  if (handle) return handle
  abandon(repoRoot, state)
  throw new NativeBuildBusyError(
    `Another or interrupted SingZ native build owns ${nativeBuildLockPath(repoRoot)}: ${state.busy}`)
}

/** Like acquireNativeBuildLock but waits, polling, until admitted. An
 *  exclusive waiter keeps its claim so later builds queue behind it. */
async function acquireNativeBuildLockWait(repoRoot, owner, options = {}) {
  const { pollMs = 500, reportMs = 30_000, onWait = () => {}, signal } = options
  const state = {}
  let reported = -Infinity
  try {
    for (;;) {
      // Cancellation removes this process's own pending claim (below) and
      // nothing else.
      if (signal?.aborted) throw new Error('Waiting for the native build lock was cancelled')
      const handle = attempt(repoRoot, owner, options, state)
      if (handle) return handle
      if (Date.now() - reported >= reportMs) {
        reported = Date.now()
        onWait(`Waiting for SingZ native build ${options.exclusive ? 'exclusivity' : 'slot'}: ${state.busy}`)
      }
      await new Promise(resolveWait => {
        const timer = setTimeout(done, pollMs)
        function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolveWait() }
        signal?.addEventListener('abort', done, { once: true })
      })
    }
  } catch (error) {
    abandon(repoRoot, state)
    throw error
  }
}

/** Free a slot (a number) or the exclusive/old-format claim ('exclusive') whose
 *  holder is provably gone. This is the only way a dead holder's lock is ever
 *  removed: it refuses unless the record is complete, same host, and the
 *  wrapper pid, process group and build process have all stopped. The caller is
 *  a human who has decided to free it; no further confirmation is asked. */
function releaseStaleNativeBuildLock(repoRoot, which) {
  const exclusive = which === 'exclusive'
  if (!exclusive && !/^[1-9][0-9]*$/.test(String(which)))
    throw new Error(`--release-stale takes a slot number or "exclusive" (got ${which})`)
  const legacy = nativeBuildLockPath(repoRoot)
  const directory = exclusive ? legacy : join(nativeBuildSlotsPath(repoRoot), `slot-${which}`)
  if (!pathExists(directory)) throw new Error(`Nothing to release: ${directory} does not exist`)

  if (exclusive) {
    // The legacy directory is the target itself, so it cannot fence itself.
    // Validate, then re-read the token immediately before removing.
    const refusal = releaseRefusal(directory)
    if (refusal) throw new Error(`Refusing to release ${directory}: ${refusal}`)
    const token = readRecord(directory)?.token
    if (readRecord(directory)?.token !== token) throw new Error(`Refusing to release ${directory}: it changed owner`)
    rmSync(directory, { recursive: true, force: false })
    return { directory, token }
  }

  // Fence: hold the legacy exclusive directory for the whole release. While it
  // exists no slot can be taken (takers back off), so the dead slot validated
  // here cannot be removed and re-acquired underneath this call, and two
  // overlapping releases cannot both run: the second finds the claim held.
  const claimToken = newToken()
  try {
    mkdirSync(legacy)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`Refusing to release ${directory}: the exclusive lock directory ${legacy} is held ` +
      `(${describeHolders([{ directory: legacy, label: 'exclusive/old-format' }])}); another release or an exclusive build is in progress, retry later`)
  }
  try {
    writeRecord(legacy, {
      format: RECORD_FORMAT, token: claimToken, pid: process.pid, owner: 'release-stale',
      hostname: hostname(), repoIdentity: gitCommonDirectory(repoRoot), checkout: resolve(repoRoot),
      startedAt: new Date().toISOString(), exclusive: true, draining: true
    })
    // Re-check under the fence: the slot may have been released meanwhile.
    if (!pathExists(directory)) throw new Error(`Nothing to release: ${directory} does not exist`)
    const refusal = releaseRefusal(directory)
    if (refusal) throw new Error(`Refusing to release ${directory}: ${refusal}`)
    const token = readRecord(directory)?.token
    rmSync(directory, { recursive: true, force: false })
    return { directory, token }
  } finally {
    if (readRecord(legacy)?.token === claimToken || !pathExists(join(legacy, 'owner.json')))
      rmSync(legacy, { recursive: true, force: true })
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
  nativeBuildSlotsPath,
  releaseStaleNativeBuildLock,
  updateNativeBuildLockRecord
}
