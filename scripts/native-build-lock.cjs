const { createHash, randomBytes } = require('node:crypto')
const {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { isAbsolute, join, resolve } = require('node:path')
const { execFileSync } = require('node:child_process')

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

function nativeBuildLockPath(repoRoot) {
  let identity = gitCommonDirectory(repoRoot)
  if (process.platform === 'win32') identity = identity.toLowerCase()
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return join(tmpdir(), `singz-native-build-${digest}.lock`)
}

function acquireNativeBuildLock(repoRoot, owner) {
  const path = nativeBuildLockPath(repoRoot)
  const token = `${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`
  try {
    mkdirSync(path)
  } catch (error) {
    let current = 'unreadable owner'
    try { current = readFileSync(join(path, 'owner.json'), 'utf8').trim() } catch { /* diagnostic only */ }
    const wrapped = new Error(
      `Another or interrupted SingZ native build owns ${path}: ${current}`
    )
    wrapped.cause = error
    throw wrapped
  }
  try {
    writeFileSync(join(path, 'owner.json'), `${JSON.stringify({
      format: 1,
      token,
      pid: process.pid,
      owner,
      repoIdentity: gitCommonDirectory(repoRoot),
      checkout: resolve(repoRoot),
      startedAt: new Date().toISOString()
    }, null, 2)}\n`)
  } catch (error) {
    rmSync(path, { recursive: true, force: true })
    throw error
  }
  let released = false
  return {
    path,
    token,
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

function assertNativeBuildLockHeld(repoRoot, token) {
  if (typeof token !== 'string' || token.length < 16)
    throw new Error('Native build lock token is missing or malformed')
  const path = nativeBuildLockPath(repoRoot)
  let record
  try {
    record = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'))
  } catch (error) {
    const wrapped = new Error(`Native build lock is not held at ${path}`)
    wrapped.cause = error
    throw wrapped
  }
  if (record.token !== token || record.repoIdentity !== gitCommonDirectory(repoRoot))
    throw new Error(`Native build lock token does not own ${path}`)
  return record
}

module.exports = {
  acquireNativeBuildLock,
  assertNativeBuildLockHeld,
  gitCommonDirectory,
  nativeBuildLockPath
}
