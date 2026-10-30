#!/usr/bin/env node
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

function checkStagedReview(root = process.cwd(), env = process.env) {
  if (env.SINGZ_SKIP_REVIEW === '1') {
    return { bypassed: true, message: 'SingZ review gate BYPASSED: SINGZ_SKIP_REVIEW=1 (requires explicit user authorization).' }
  }
  const git = (args) => execFileSync('git', ['-C', root, ...args], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  const gitDir = git(['rev-parse', '--absolute-git-dir'])
  // Git supplies GIT_INDEX_FILE for partial commits. Reading that actual index
  // prevents an approval of the ordinary index from approving a different tree.
  const tree = git(['write-tree'])
  let approved
  try { approved = readFileSync(join(gitDir, 'singz-reviewed'), 'utf8').trim() }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error('Not reviewed yet. Stage the intended changes, have an independent reviewer approve this worktree\'s staged tree, then commit.')
  }
  if (approved !== tree)
    throw new Error('The staged tree changed since review. Review this worktree\'s actual commit tree again before committing.')
  return { bypassed: false, tree }
}

if (require.main === module) {
  try {
    const result = checkStagedReview()
    if (result.bypassed) console.error(result.message)
  } catch (error) {
    console.error(`SingZ review gate: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { checkStagedReview }
