#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { accessSync, constants, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

function installGitHooks(root, env = process.env) {
  const git = (args, missingAllowed = false) => {
    const result = spawnSync('git', ['-C', root, ...args], { env, encoding: 'utf8' })
    if (missingAllowed && result.status === 1) return ''
    if (result.status !== 0)
      throw new Error(result.error?.message || result.stderr.trim() || `git ${args.join(' ')} failed`)
    return result.stdout.trim()
  }
  const configured = git(['config', '--get', 'core.hooksPath'], true)
  if (configured && configured !== '.githooks')
    throw new Error(`Refusing to replace existing core.hooksPath=${configured}. Integrate the SingZ review hook with that hook setup explicitly.`)

  for (const name of ['pre-commit', 'prepare-commit-msg']) {
    const hook = join(root, '.githooks', name)
    accessSync(hook, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
  }
  accessSync(join(root, 'scripts', 'check-staged-review.cjs'), constants.R_OK)

  // Installing hooksPath disables the legacy hooks directory. Refuse to hide
  // any active hook there, even if it is unrelated to pre-commit.
  const common = git(['rev-parse', '--git-common-dir'])
  const legacy = resolve(root, common, 'hooks')
  let entries = []
  try { entries = readdirSync(legacy) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const active = entries.filter((name) => {
    if (name.endsWith('.sample')) return false
    const file = join(legacy, name)
    if (!statSync(file).isFile()) return false
    try {
      accessSync(file, process.platform === 'win32' ? constants.R_OK : constants.X_OK)
      return true
    } catch { return false }
  })
  // On an already-configured checkout legacy files are already inactive.
  if (!configured && active.length)
    throw new Error(`Refusing to disable existing Git hooks: ${active.join(', ')}. Integrate them with .githooks explicitly.`)
  git(['config', '--local', 'core.hooksPath', '.githooks'])
  return '.githooks'
}

if (require.main === module) {
  try {
    installGitHooks(resolve(__dirname, '..'))
    console.log('Git review hooks installed: .githooks/pre-commit + prepare-commit-msg')
  } catch (error) {
    console.error(`Git hook installation failed: ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = { installGitHooks }
