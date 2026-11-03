#!/usr/bin/env node
// Prove task-output and configuration reuse, including on a cold CI cache.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const GRADLE_ARGUMENTS = [':app:extractOrtSdk', '--no-daemon', '--max-workers=1',
  '--build-cache', '--configuration-cache', '--configuration-cache-problems=fail', '--console=plain']

function assertLocalOutput(repoRoot, output, required = false) {
  const relative = path.relative(repoRoot, output)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ORT output must remain inside the checkout')
  let cursor = repoRoot
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Refusing an ORT output path containing a symlink')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (required && (!fs.existsSync(output) || !fs.statSync(output).isDirectory() || !fs.readdirSync(output).length))
    throw new Error('ORT extraction did not produce local SDK outputs')
}

function exerciseAndroidCaches({ repoRoot = path.resolve(__dirname, '..'),
  reportDir = process.env.SINGZ_CI_CACHE_REPORT_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'singz-cache-report'),
  run = spawnSync, env = process.env } = {}) {
  repoRoot = path.resolve(repoRoot)
  const android = path.join(repoRoot, 'mobile/android')
  const output = path.join(android, 'app/build/ort-sdk')
  fs.mkdirSync(reportDir, { recursive: true })
  const result = { platform: 'android', task: ':app:extractOrtSdk', verified: false, runs: [] }
  const save = () => fs.writeFileSync(path.join(reportDir, 'android-cache-smoke.json'), JSON.stringify(result, null, 2) + '\n')
  const invoke = name => {
    const command = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
    const execution = run(command, [...GRADLE_ARGUMENTS], {
      cwd: android, env, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
    })
    const text = (execution.stdout || '') + (execution.stderr || '')
    fs.writeFileSync(path.join(reportDir, `android-cache-smoke-${name}.log`), text)
    const row = { name, exit: execution.status,
      fromCache: /^> Task :app:extractOrtSdk FROM-CACHE\s*$/m.test(text),
      configurationReused: /Reusing configuration cache|Configuration cache entry reused/.test(text) }
    result.runs.push(row)
    if (execution.error || execution.status !== 0)
      throw new Error(`Gradle cache proof ${name} failed: ${execution.error?.message || `exit ${execution.status}`}; see ${reportDir}`)
    assertLocalOutput(repoRoot, output, true)
    return row
  }
  try {
    assertLocalOutput(repoRoot, output)
    invoke('prime')
    // RN can update its generated package checksum during the first graph.
    // Permit one extra exact-graph run for that input to settle; never relax
    // strict configuration compatibility or accept a non-cacheable ORT task.
    for (const name of ['restore', 'settled-restore']) {
      assertLocalOutput(repoRoot, output, true)
      fs.rmSync(output, { recursive: true })
      const row = invoke(name)
      if (!row.fromCache) throw new Error(`ORT SDK was not restored FROM-CACHE; see ${reportDir}`)
      if (row.configurationReused) {
        result.verified = true
        save()
        return result
      }
    }
    throw new Error(`Gradle configuration graph was not reused after generated inputs settled; see ${reportDir}`)
  } catch (error) {
    result.error = error.message
    save()
    throw error
  }
}

module.exports = { exerciseAndroidCaches, GRADLE_ARGUMENTS }

if (require.main === module) {
  if (process.argv.length > 2) {
    console.error('Usage: node scripts/ci-android-cache-smoke.cjs')
    process.exitCode = 2
  } else if (!process.env.SINGZ_NATIVE_BUILD_LOCK_HELD) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'with-native-build-lock.mjs'),
      '--owner', 'ci-android-cache-smoke', '--', process.execPath, __filename], { stdio: 'inherit' })
    process.exitCode = result.status ?? 1
  } else {
    try {
      const root = path.resolve(__dirname, '..')
      require('./native-build-lock.cjs').assertNativeBuildLockHeld(root, process.env.SINGZ_NATIVE_BUILD_LOCK_HELD)
      const result = exerciseAndroidCaches({ repoRoot: root })
      console.log(`Android cache proof: ORT FROM-CACHE and configuration graph reused (${result.runs.length} runs)`)
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
