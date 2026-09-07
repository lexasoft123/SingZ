#!/usr/bin/env node

const { join, resolve } = require('node:path')
const {
  captureTarget,
  packageRoot,
  verifyCaptureSnapshot
} = require('./capture-artifact.cjs')

const root = resolve(__dirname, '..')
const target = process.argv[2] || captureTarget(process.platform, process.arch)
const snapshot = packageRoot(root, target)
const electronVersion = require(join(root, 'node_modules/electron/package.json')).version
verifyCaptureSnapshot(snapshot, {
  expectedTargets: target.startsWith('darwin-') ? [target, 'darwin-universal'] : target,
  electronVersion
})
console.log(`verified: build/capture-package/${target}/singz-capture.node`)
