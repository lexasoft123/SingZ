#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const path = require('node:path')

// The Android Gradle plugin unconditionally requests --reset-cache. Metro
// already invalidates transforms by content/config; preserve them unless a
// developer explicitly asks for the upstream reset while diagnosing a build.
function incrementalArguments(args, env = process.env) {
  return env.SINGZ_METRO_RESET_CACHE === '1'
    ? [...args]
    : args.filter(arg => arg !== '--reset-cache')
}

module.exports = { incrementalArguments }

if (require.main === module) {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, '../node_modules/react-native/scripts/bundle.js'),
    ...incrementalArguments(process.argv.slice(2)),
  ], { stdio: 'inherit', env: process.env })
  if (result.error) console.error(`Android bundle failed: ${result.error.message}`)
  if (result.signal) process.kill(process.pid, result.signal)
  else process.exit(result.status ?? 1)
}
