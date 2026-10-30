#!/usr/bin/env node
'use strict'

const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const repoRoot = join(__dirname, '..', '..')
execFileSync('python3', [
  join(repoRoot, 'scripts', 'verify-zcore-submodule.py'),
  '--root', repoRoot,
  '--path', 'third_party/zcore',
], { cwd: repoRoot, stdio: 'inherit' })
