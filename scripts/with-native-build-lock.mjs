#!/usr/bin/env node
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const { acquireNativeBuildLock } = require('./native-build-lock.cjs')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const separator = process.argv.indexOf('--')
const ownerIndex = process.argv.indexOf('--owner')
if (ownerIndex < 0 || ownerIndex + 1 >= separator || separator < 0 ||
    separator + 1 >= process.argv.length)
  throw new Error('Usage: with-native-build-lock.mjs --owner <label> -- <command> [args...]')
const owner = process.argv[ownerIndex + 1]
const command = process.argv[separator + 1]
const args = process.argv.slice(separator + 2)
const lock = acquireNativeBuildLock(root, owner)
// stderr keeps wrappers with a machine-readable/stdout-only contract (notably
// build-analyze-host.sh) composable while still making lock ownership visible.
console.error(`SingZ native build lock: ${lock.path} (${owner})`)

let child
let forwardedSignal = null
try {
  child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, SINGZ_NATIVE_BUILD_LOCK_HELD: lock.token },
    stdio: 'inherit',
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      forwardedSignal = signal
      if (child && !child.killed) child.kill(signal)
    })
  }
  const result = await new Promise((resolveChild, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveChild({ code, signal }))
  })
  if (forwardedSignal || result.signal) process.exitCode = 128
  else process.exitCode = result.code ?? 1
} finally {
  lock.release()
}
