#!/usr/bin/env node
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const kinds = ['compiler', 'gradle', 'audio', 'pods', 'metro', 'archives']
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} exited ${result.status}`)
  return result.stdout
}
function output(file, key, value) {
  if (!file) return
  const delimiter = `SINGZ_${crypto.randomBytes(12).toString('hex')}`
  fs.appendFileSync(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`)
}
function createState(env = process.env, home = os.homedir()) {
  const platform = env.CACHE_PLATFORM
  if (!['ios', 'android'].includes(platform)) throw new Error('CACHE_PLATFORM must be ios or android')
  const token = value => {
    if (!value || !/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Missing or unsafe CI cache identity')
    return value
  }
  const scope = [env.RUNNER_OS, env.RUNNER_ARCH || process.arch, env.CACHE_TOOLCHAIN].map(token).join('-')
  const deps = token(env.CACHE_DEPS), sources = token(env.CACHE_SOURCES)
  const metroSources = token(env.CACHE_METRO_SOURCES)
  const job = token(env.GITHUB_JOB || 'local')
  const generation = `${token(env.GITHUB_RUN_ID || 'local')}-${token(env.GITHUB_RUN_ATTEMPT || '1')}`
  const base = platform === 'ios' ? path.join(home, 'Library/Caches') : path.join(home, '.cache')
  const archiveRoot = path.join(home, 'Library/Caches/SingZ/ios-native-archives')
  const mutable = (prefix, source, filename, enabled = true) => ({
    enabled, path: filename, key: `${prefix}-${scope}-${deps}-${source}-${job}-${generation}`,
    restore: [`${prefix}-${scope}-${deps}-${source}-${job}-`, `${prefix}-${scope}-${deps}-${source}-`, `${prefix}-${scope}-${deps}-`],
  })
  return { version: 1, platform,
    reportDir: path.join(env.RUNNER_TEMP || os.tmpdir(), 'singz-cache-report'),
    archiveRoot,
    caches: {
      compiler: mutable('mobile-ccache-v3', sources, platform === 'ios' ? path.join(base, 'ccache') : path.join(home, '.ccache')),
      gradle: mutable('mobile-gradle-v2', sources, `${path.join(home, '.gradle/caches')}\n${path.join(home, '.gradle/wrapper')}`, platform === 'android'),
      audio: { enabled: true, path: path.join(base, 'SingZ/audio-api-prebuilts'), key: `audio-api-downloads-v2-${scope}-${deps}`, restore: [] },
      pods: { enabled: platform === 'ios', path: `${path.join(base, 'CocoaPods')}\n${path.join(base, 'ReactNative')}`, key: `cocoa-downloads-v2-${scope}-${deps}`, restore: [] },
      metro: mutable('metro-transforms-v1', metroSources, path.join(base, 'SingZ/metro')),
      archives: mutable('ios-native-archives-v3', sources, `${archiveRoot}/*/SingZ.xcarchive`, platform === 'ios' && env.CACHE_ARCHIVES === 'true'),
    } }
}
function readState(raw) {
  const state = JSON.parse(raw)
  if (state.version !== 1 || !['ios', 'android'].includes(state.platform)) throw new Error('Unrecognized cache state')
  for (const kind of kinds) {
    const item = state.caches?.[kind]
    if (!item || typeof item.enabled !== 'boolean' || typeof item.path !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(item.key)) throw new Error(`Invalid ${kind} cache state`)
  }
  return state
}
function parseStats(text) {
  // Ubuntu's distro ccache predates --format=json; TSV works on both hosts.
  const stats = {}
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-z0-9_]+)\s+(\d+)$/.exec(line)
    if (!match) throw new Error('Malformed compiler cache statistics')
    stats[match[1]] = Number(match[2])
  }
  for (const name of ['cache_miss', 'direct_cache_hit', 'preprocessed_cache_hit'])
    if (!Number.isSafeInteger(stats[name])) throw new Error(`Missing compiler cache statistic: ${name}`)
  return stats
}
function cacheStats() { return parseStats(run('ccache', ['--print-stats'])) }
function deltaStats(before, after) {
  const delta = {}
  for (const [key, value] of Object.entries(after)) if (typeof value === 'number') delta[key] = value - (before[key] || 0)
  if (['cache_miss', 'direct_cache_hit', 'preprocessed_cache_hit'].some(key => delta[key] < 0)) throw new Error('Compiler cache counters were reset during the build')
  return delta
}
function nativeEvidence(delta, logs) {
  const calls = (delta.cache_miss || 0) + (delta.direct_cache_hit || 0) + (delta.preprocessed_cache_hit || 0)
  if (calls > 0) return 'compiler cache invoked'
  if (logs.includes('Native inputs unchanged: rebundling JavaScript and exporting cached archive') &&
      logs.includes('Successfully exported and signed the ipa file:') && !logs.includes('Cached export failed;')) return 'validated native archive reused'
  const tasks = [...logs.matchAll(/^> Task (\S*:(?:buildCMake|compile\S*Native)\S*)(?: (FROM-CACHE|UP-TO-DATE|NO-SOURCE|SKIPPED))?$/gm)]
  if (tasks.length && tasks.every(task => task[2]) && tasks.some(task => ['FROM-CACHE', 'UP-TO-DATE'].includes(task[2]))) return 'native Gradle outputs reused'
  return null
}
function verifyConfiguration(platform, repo = root, env = process.env) {
  run('ccache', ['--version'])
  if (!env.CCACHE_DIR || !env.SINGZ_METRO_CACHE_DIR) throw new Error('Shared CI cache paths were not exported before the build')
  if (platform === 'ios') {
    const result = require(path.join(repo, 'mobile/scripts/ccache-xcode-conf.js')).configureXcodeCache(repo, env, { checkOnly: true })
    if (result.skipped || result.changed || !result.ccache) throw new Error('Xcode compiler wrappers/configuration are stale; run mobile postinstall after restoring CI cache settings')
  } else {
    const properties = fs.readFileSync(path.join(repo, 'mobile/android/gradle.properties'), 'utf8')
    for (const flag of ['org.gradle.caching', 'org.gradle.configuration-cache']) {
      if (!properties.split(/\r?\n/).includes(`${flag}=true`)) throw new Error(`${flag} must be enabled`)
    }
  }
}
function validArchiveStore(directory, verifySignature = archive => spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.join(archive, 'Products/Applications/SingZPlayer.app')], { stdio: 'ignore' }).status === 0) {
  if (!fs.existsSync(directory)) return { valid: 0, invalid: 0 }
  let valid = 0, invalid = 0
  for (const name of fs.readdirSync(directory)) {
    const parent = path.join(directory, name), archive = path.join(parent, 'SingZ.xcarchive')
    if (!/^[a-f0-9]{64}$/.test(name)) { if (fs.existsSync(archive)) invalid++; continue }
    if (fs.lstatSync(parent).isSymbolicLink()) { invalid++; continue }
    if (!fs.existsSync(archive)) continue // interrupted staging directories are not in the saved glob
    try {
      if (fs.lstatSync(archive).isSymbolicLink()) throw new Error('linked archive')
      const receipt = JSON.parse(fs.readFileSync(path.join(archive, '.singz-native-inputs.json'), 'utf8'))
      const app = path.join(archive, 'Products/Applications/SingZPlayer.app')
      if (fs.lstatSync(app).isSymbolicLink() || fs.lstatSync(path.join(app, 'SingZPlayer')).isSymbolicLink()) throw new Error('linked application')
      const binary = fs.readFileSync(path.join(app, 'SingZPlayer'))
      if (receipt.format !== 1 || receipt.inputs !== name || receipt.binary !== crypto.createHash('sha256').update(binary).digest('hex') ||
          !fs.existsSync(path.join(app, 'Info.plist')) || !fs.existsSync(path.join(archive, 'Info.plist')) || !verifySignature(archive)) throw new Error('invalid archive')
      valid++
    } catch { invalid++ }
  }
  return { valid, invalid }
}
function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv.shift()
  if (command === 'setup') {
    const state = createState(env)
    output(env.GITHUB_OUTPUT, 'state', JSON.stringify(state))
    for (const kind of kinds) for (const field of ['path', 'key', 'restore']) output(env.GITHUB_OUTPUT, `${kind}-${field}`, Array.isArray(state.caches[kind][field]) ? state.caches[kind][field].join('\n') : state.caches[kind][field])
    for (const [key, value] of Object.entries({ CCACHE_DIR: state.caches.compiler.path, CCACHE_MAXSIZE: '1200M', SINGZ_AUDIO_API_CACHE: state.caches.audio.path,
      SINGZ_METRO_CACHE_DIR: state.caches.metro.path, SINGZ_CI_CACHE_REPORT_DIR: state.reportDir, SINGZ_CI_CACHE_STATE: JSON.stringify(state),
      SINGZ_IOS_NATIVE_CACHE_MAX_ENTRIES: '2', SINGZ_IOS_NATIVE_CACHE_MAX_BYTES: '1073741824', SINGZ_IOS_NATIVE_CACHE_MAX_AGE_DAYS: '14' })) output(env.GITHUB_ENV, key, value)
    return
  }
  if (command === 'record-restores') {
    const state = readState(env.SINGZ_CI_CACHE_STATE)
    for (const kind of kinds) state.caches[kind].matched = env[`SINGZ_MATCH_${kind.toUpperCase()}`] || ''
    output(env.GITHUB_OUTPUT, 'state', JSON.stringify(state)); output(env.GITHUB_ENV, 'SINGZ_CI_CACHE_STATE', JSON.stringify(state)); return
  }
  if (command === 'finalize') {
    if (!env.SINGZ_CI_CACHE_STATE) return
    const state = readState(env.SINGZ_CI_CACHE_STATE)
    for (const kind of kinds) {
      const item = state.caches[kind]
      let save = item.enabled && item.matched !== item.key && item.path.split('\n').some(filename => fs.existsSync(filename.replace(/\/\*\/SingZ\.xcarchive$/, '')))
      if (['audio', 'pods'].includes(kind) && !fs.existsSync(path.join(state.reportDir, `${state.platform}-baseline.json`))) save = false
      if (kind === 'archives' && save) {
        const result = validArchiveStore(state.archiveRoot)
        save = result.valid > 0 && result.invalid === 0
        console.log(`Completed signed archive entries: ${result.valid}; invalid entries: ${result.invalid}`)
      }
      output(env.GITHUB_OUTPUT, `${kind}-save`, String(save)); output(env.GITHUB_OUTPUT, `${kind}-key`, item.key); output(env.GITHUB_OUTPUT, `${kind}-path`, item.path)
    }
    return
  }
  const platformIndex = argv.indexOf('--platform'), platform = argv[platformIndex + 1]
  if (platformIndex < 0 || !['ios', 'android'].includes(platform)) throw new Error('Specify --platform ios or android')
  const directory = env.SINGZ_CI_CACHE_REPORT_DIR || path.join(env.RUNNER_TEMP || os.tmpdir(), 'singz-cache-report')
  fs.mkdirSync(directory, { recursive: true })
  const baseline = path.join(directory, `${platform}-baseline.json`)
  if (command === 'begin') {
    verifyConfiguration(platform, root, env)
    fs.writeFileSync(baseline, JSON.stringify({ stats: cacheStats(), state: env.SINGZ_CI_CACHE_STATE ? readState(env.SINGZ_CI_CACHE_STATE) : null }, null, 2))
    console.log(`${platform}: compiler-cache configuration verified; counters recorded without resetting them`); return
  }
  if (command !== 'report') throw new Error('Expected setup, record-restores, finalize, begin, or report')
  if (!fs.existsSync(baseline)) {
    if (argv.includes('--require-native')) throw new Error('Native cache measurement did not start')
    console.log('Native cache measurement did not start; build setup may have failed'); return
  }
  const before = JSON.parse(fs.readFileSync(baseline, 'utf8')), delta = deltaStats(before.stats, cacheStats())
  let logs = ''
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--log') { const file = argv[++i]; if (fs.existsSync(file)) logs += fs.readFileSync(file, 'utf8') + '\n' }
  const evidence = nativeEvidence(delta, logs), taskHits = (logs.match(/^> Task .* FROM-CACHE$/gm) || []).length
  const summary = { platform, evidence, hits: (delta.direct_cache_hit || 0) + (delta.preprocessed_cache_hit || 0), misses: delta.cache_miss || 0,
    gradleTasksFromCache: taskHits, configurationReused: /Configuration cache entry reused|Reusing configuration cache/.test(logs), delta, caches: before.state?.caches }
  fs.writeFileSync(path.join(directory, `${platform}-report.json`), JSON.stringify(summary, null, 2))
  const markdown = `### ${platform} build caches\n\nCompiler hits: ${summary.hits}; misses: ${summary.misses}. Evidence: ${evidence || 'none observed'}.\n\nGradle tasks restored: ${taskHits}; configuration reused: ${summary.configurationReused}.\n\n` +
    Object.entries(before.state?.caches || {}).filter(([, item]) => item.enabled).map(([kind, item]) => `- ${kind}: ${item.matched ? `restored ${item.matched}` : 'cold restore'}\n`).join('')
  fs.writeFileSync(path.join(directory, `${platform}-report.md`), markdown)
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown)
  console.log(markdown)
  if (argv.includes('--require-native') && !evidence) throw new Error('No compiler-cache activity or verified native-output reuse; cache may be bypassed')
}
module.exports = { createState, readState, parseStats, deltaStats, nativeEvidence, verifyConfiguration, validArchiveStore, main }
if (require.main === module) { try { main() } catch (error) { console.error(error.message); process.exitCode = 1 } }
