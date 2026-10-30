#!/usr/bin/env node
'use strict'

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const repoRoot = join(__dirname, '..', '..')
const engineRoot = join(repoRoot, 'third_party', 'audio-engine')
const lockPath = join(repoRoot, 'third_party', 'audio-engine.lock.json')
execFileSync('python3', [
  join(engineRoot, 'scripts', 'verify-audioz.py'),
  '--root', engineRoot,
  '--lock', lockPath,
], { cwd: repoRoot, stdio: 'inherit' })
