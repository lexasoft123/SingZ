#!/usr/bin/env node
/**
 * Run a command with CMake's compiler-launcher environment pointed at ccache
 * when the machine has it — every native module's NDK compile gets cached
 * without touching third-party build files (the Android CI build uses the
 * same mechanism). Without ccache the command runs untouched.
 */
const { spawnSync } = require('child_process')

const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ccache'])
const env = { ...process.env }
if (probe.status === 0) {
  env.CMAKE_C_COMPILER_LAUNCHER = env.CMAKE_C_COMPILER_LAUNCHER || 'ccache'
  env.CMAKE_CXX_COMPILER_LAUNCHER = env.CMAKE_CXX_COMPILER_LAUNCHER || 'ccache'
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
