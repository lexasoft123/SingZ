#!/usr/bin/env node

const { resolve } = require('node:path')
const { assertNativeBuildLockHeld } = require('./native-build-lock.cjs')

// `--exclusive`: producers that write shared locations must hold the lock
// alone, not merely one of the parallel slots.
const root = resolve(__dirname, '..')
assertNativeBuildLockHeld(root, process.env.SINGZ_NATIVE_BUILD_LOCK_HELD, {
  exclusive: process.argv.includes('--exclusive'),
})
