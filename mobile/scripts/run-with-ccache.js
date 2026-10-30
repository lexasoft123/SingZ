#!/usr/bin/env node
/**
 * Run an Android command. Every native module gets worktree-portable compiler
 * identity and PCH settings from android-cmake-init's shared compiler launcher,
 * including builds launched directly by Gradle or Android Studio. Keep policy
 * in that one launcher rather than duplicating it in this process environment.
 * Do not also set CMake's compiler launcher here: stacking the two makes
 * ccache wrap ccache and caches nothing. Without ccache the command runs
 * untouched.
 */
const { spawnSync } = require('child_process')

const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ccache'])
const env = { ...process.env }
if (probe.status !== 0) {
  console.log('ccache not found — native builds run without a compiler cache')
}

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: run-with-ccache.js <command> [args...]')
  process.exit(2)
}
const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
process.exit(r.status === null ? 1 : r.status)
