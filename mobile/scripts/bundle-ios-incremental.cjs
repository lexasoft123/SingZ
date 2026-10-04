#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const path = require('node:path')

// The official Xcode bundling script forces a Metro reset on every invocation.
// Metro already keys transforms by source/config; keep those transforms on
// native-cache hits while still producing a new bundle and Hermes bytecode.
const incrementalArguments = args => args.filter(arg => arg !== '--reset-cache')
module.exports = { incrementalArguments }
if (require.main === module) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../node_modules/react-native/scripts/bundle.js'),
    ...incrementalArguments(process.argv.slice(2)),
  ], { stdio: 'inherit', env: process.env })
  process.exit(result.status ?? 1)
}
