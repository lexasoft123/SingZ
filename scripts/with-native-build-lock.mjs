#!/usr/bin/env node
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

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
const posix = process.platform !== 'win32'
const signalHandlers = new Map()

function groupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    // Permission errors do not prove that the group has stopped.
    return true
  }
}

async function descendantsStopped() {
  if (!child?.pid) return true // spawn failed before a process existed
  if (!posix) {
    // Node cannot prove a Windows process tree has quiesced after interruption.
    // Ordinary producers must await their children before normal completion;
    // interrupted builds keep the lock for an operator to inspect, even after
    // taskkill reports success.
    return !forwardedSignal && child.signalCode === null
  }
  // A direct child's exit does not imply its compiler descendants exited. Give
  // a terminating group a short grace, then leave the lock in place if any
  // process (including an unreaped descendant) is still visible in that group.
  for (let attempt = 0; attempt < 20; ++attempt) {
    if (!groupExists(child.pid)) return true
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  return !groupExists(child.pid)
}

try {
  child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, SINGZ_NATIVE_BUILD_LOCK_HELD: lock.token },
    stdio: 'inherit',
    // A private process group lets a signal reach the entire compiler tree.
    detached: posix,
  })
  if (child.pid) {
    const ownerFile = join(lock.path, 'owner.json')
    const record = JSON.parse(readFileSync(ownerFile, 'utf8'))
    writeFileSync(ownerFile, `${JSON.stringify({ ...record,
      childPid: child.pid, processGroup: posix ? child.pid : null,
    }, null, 2)}\n`)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      forwardedSignal = signal
      if (!child?.pid) return
      if (posix) {
        try { process.kill(-child.pid, signal) } catch (error) {
          if (error.code !== 'ESRCH') console.error(`Could not signal native build group: ${error.message}`)
        }
      } else {
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
        })
        if (result.error || result.status !== 0)
          console.error(`Could not confirm native build tree termination: ${result.error?.message || result.stderr?.trim()}`)
      }
    }
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }
  const result = await new Promise((resolveChild, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveChild({ code, signal }))
  })
  if (forwardedSignal || result.signal) process.exitCode = 128
  else process.exitCode = result.code ?? 1
} finally {
  if (await descendantsStopped()) lock.release()
  else {
    console.error(`Native build descendants may still be running; lock retained at ${lock.path}. Inspect owner.json and stop the recorded process group/tree before removing it.`)
    if (!process.exitCode) process.exitCode = 1
  }
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
}
