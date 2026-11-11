#!/usr/bin/env node
// Compatibility shim: the shared native build lock was removed, so this only
// runs the command. Builds in different worktrees may run in parallel.
import { spawnSync } from 'node:child_process'

const separator = process.argv.indexOf('--')
const ownerIndex = process.argv.indexOf('--owner')
if (ownerIndex < 0 || ownerIndex + 1 >= separator || separator < 0 ||
    separator + 1 >= process.argv.length)
  throw new Error('Usage: with-native-build-lock.mjs --owner <label> -- <command> [args...]')
const result = spawnSync(process.argv[separator + 1], process.argv.slice(separator + 2), { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 128
