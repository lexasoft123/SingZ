#!/usr/bin/env node

const { resolve } = require('node:path')
const { assertNativeBuildLockHeld } = require('./native-build-lock.cjs')

const root = resolve(__dirname, '..')
assertNativeBuildLockHeld(root, process.env.SINGZ_NATIVE_BUILD_LOCK_HELD)
