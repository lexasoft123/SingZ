#!/usr/bin/env node
/**
 * Run an Android command with ccache's worktree-portable identity in its
 * environment. React Native installs the one compiler launcher in its CMake
 * application include; the app CMake file enriches that launcher with these
 * same settings for direct Gradle builds. Native concurrency is enforced for
 * every Android CMake project by android/build.gradle plus android-cmake-init.
 * Do not also set CMake's compiler launcher here: stacking the two makes
 * ccache wrap ccache and caches nothing. Without ccache the command runs
 * untouched.
 */
const { spawnSync } = require('child_process')
const path = require('path')

const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ccache'])
const env = { ...process.env }
if (probe.status === 0) {
  // Cross-worktree hits: the NDK compiles with absolute paths and Debug adds
  // -g (which hashes the CWD), so without these a sibling checkout shares the
  // cache dir and hits nothing in it. base_dir is this checkout's own root —
  // paths under it hash relative, so every worktree agrees. Env only: we set
  // no ccache config file, the machine's own settings stay untouched.
  env.CCACHE_BASEDIR = env.CCACHE_BASEDIR || path.resolve(__dirname, '..', '..')
  env.CCACHE_NOHASHDIR = env.CCACHE_NOHASHDIR || '1'
  env.CCACHE_COMPILERCHECK = env.CCACHE_COMPILERCHECK || 'content'
} else {
  console.log('ccache not found — native builds run without a compiler cache')
}

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: run-with-ccache.js <command> [args...]')
  process.exit(2)
}
const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
process.exit(r.status === null ? 1 : r.status)
