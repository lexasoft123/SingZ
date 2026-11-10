'use strict'

const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { realpathSync } = require('node:fs')

const OID_RE = /^[0-9a-f]{40,64}$/

/** Read the stable zCore gitlink OID from the consumer index.
 *
 * Build/bootstrap boundaries run verify-zcore-submodule.py first, which also
 * checks the child checkout and cleanliness. This lightweight read is for
 * source fingerprints at runtime, where requiring Python would be a new
 * Windows development dependency.
 */
function submoduleGitlinkRevision(root, submodulePath) {
  const absoluteRoot = resolve(root)
  const result = spawnSync('git', [
    '-c', `safe.directory=${absoluteRoot}`,
    '-C', absoluteRoot,
    'ls-files', '--stage', '-z', '--', submodulePath
  ], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  })
  if (result.status !== 0) {
    throw new Error(`Could not read the zCore gitlink from the Git index: ${result.stderr || result.error || 'git failed'}`)
  }
  const records = result.stdout.split('\0').filter(Boolean)
  if (records.length !== 1) {
    throw new Error('The parent index must contain exactly one zCore gitlink entry')
  }
  const [metadata, path] = records[0].split('\t', 2)
  const [mode, oid, stage] = (metadata || '').split(' ')
  if (path !== submodulePath || mode !== '160000' || stage !== '0' || !OID_RE.test(oid || '')) {
    throw new Error('The parent index does not contain one valid stage-0 zCore gitlink')
  }
  return oid
}

function zcoreGitlinkRevision(root) {
  return submoduleGitlinkRevision(root, 'third_party/zcore')
}

// Both the cached builder and development loader call this before accepting a
// source stamp. A cache hit must not bypass the clean, exact source pin checked
// by CMake on a real rebuild. Keep this check offline and independent of Python.
function loopzBuildInputs(root) {
  const revision = submoduleGitlinkRevision(root, 'third_party/loopz')
  const child = resolve(root, 'third_party/loopz')
  const git = (args) => {
    const result = spawnSync('git', ['-c', `safe.directory=${child}`, '-C', child, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    })
    if (result.status !== 0) {
      throw new Error(`Could not verify LoopZ source: ${result.stderr || result.error || 'git failed'}`)
    }
    return result.stdout
  }
  const top = git(['rev-parse', '--show-toplevel']).trim()
  if (realpathSync(top) !== realpathSync(child)) {
    throw new Error('LoopZ sources are not an initialized submodule checkout')
  }
  if (git(['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== revision) {
    throw new Error('LoopZ checkout does not match the parent gitlink')
  }
  if (git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']).trim()) {
    throw new Error('LoopZ checkout is dirty; preserve and commit its changes before building')
  }
  // Include the compiled JSON provider, but not the nested zCore gitlink: the
  // host fingerprints its single shared zCore separately. GUI/generated inputs
  // are not used by the embedded Control/Runtime build.
  const files = git(['ls-files', '-z', '--', 'CMakeLists.txt', '.gitmodules',
    'native/core', 'native/runtime', 'native/include', 'cmake', 'scripts',
    'vendor/nlohmann']).split('\0').filter(Boolean).map(path => resolve(child, path))
  if (!files.length) throw new Error('LoopZ build inputs are missing; initialize its submodule')
  return { revision, files }
}

// LoopZ routing is compiled into the capture addon only for Linux (the Box
// target). Desktop macOS/Windows builds configure SINGZ_BOX_LOOPZ_ROUTING=OFF,
// so their builder and development loader must neither fingerprint nor require
// a clean LoopZ checkout. Both sides use this one gate so stamps still agree.
function boxLoopzRoutingEnabled(platform) {
  return platform === 'linux'
}

function loopzFingerprintInputs(root, platform) {
  return boxLoopzRoutingEnabled(platform) ? loopzBuildInputs(root) : null
}

module.exports = { zcoreGitlinkRevision, loopzBuildInputs, boxLoopzRoutingEnabled, loopzFingerprintInputs }
