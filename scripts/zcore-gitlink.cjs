'use strict'

const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const OID_RE = /^[0-9a-f]{40,64}$/

/** Read the stable zCore gitlink OID from the consumer index.
 *
 * Build/bootstrap boundaries run verify-zcore-submodule.py first, which also
 * checks the child checkout and cleanliness. This lightweight read is for
 * source fingerprints at runtime, where requiring Python would be a new
 * Windows development dependency.
 */
function zcoreGitlinkRevision(root) {
  const absoluteRoot = resolve(root)
  const result = spawnSync('git', [
    '-c', `safe.directory=${absoluteRoot}`,
    '-C', absoluteRoot,
    'ls-files', '--stage', '-z', '--', 'third_party/zcore'
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
  if (path !== 'third_party/zcore' || mode !== '160000' || stage !== '0' || !OID_RE.test(oid || '')) {
    throw new Error('The parent index does not contain one valid stage-0 zCore gitlink')
  }
  return oid
}

module.exports = { zcoreGitlinkRevision }
