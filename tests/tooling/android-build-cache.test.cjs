const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const { incrementalArguments } = require('../../mobile/scripts/bundle-android-incremental.cjs')
const { patchGradleCaches } = require('../../mobile/scripts/patch-gradle-cache.cjs')

const root = resolve(__dirname, '../..')
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell launcher fixture' : false }
const cmakeAvailable = spawnSync('cmake', ['--version'], { encoding: 'utf8' }).status === 0

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'singz android cache '))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('Android Metro keeps every bundling argument except the forced reset', () => {
  const args = ['bundle', '--platform', 'android', '--dev', 'false', '--reset-cache',
    '--minify', 'true', '--bundle-output', '/output path/main.bundle', '--assets-dest', '/assets']
  assert.deepEqual(incrementalArguments(args, {}), args.filter(arg => arg !== '--reset-cache'))
  assert.deepEqual(incrementalArguments(args, { SINGZ_METRO_RESET_CACHE: '1' }), args)
  assert.deepEqual(args, ['bundle', '--platform', 'android', '--dev', 'false', '--reset-cache',
    '--minify', 'true', '--bundle-output', '/output path/main.bundle', '--assets-dest', '/assets'])
})

test('Android bundling delegates to the official CLI and preserves environment and status', t => {
  const directory = fixture(t)
  const scripts = join(directory, 'mobile', 'scripts')
  const official = join(directory, 'mobile', 'node_modules', 'react-native', 'scripts')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(official, { recursive: true })
  const wrapper = join(scripts, 'bundle-android-incremental.cjs')
  copyFileSync(join(root, 'mobile/scripts/bundle-android-incremental.cjs'), wrapper)
  writeFileSync(join(official, 'bundle.js'), `
    console.log(JSON.stringify({args: process.argv.slice(2), token: process.env.SINGZ_FIXTURE_TOKEN}));
    if (process.env.SINGZ_FIXTURE_SIGNAL) process.kill(process.pid, process.env.SINGZ_FIXTURE_SIGNAL);
    process.exitCode = Number(process.env.SINGZ_FIXTURE_STATUS || 0);
  `)
  const args = ['bundle', '--platform', 'android', '--reset-cache', '--bundle-output', 'a b;literal.bundle']
  const env = { ...process.env, SINGZ_FIXTURE_TOKEN: 'inherited', SINGZ_FIXTURE_STATUS: '23' }
  delete env.SINGZ_METRO_RESET_CACHE
  const incremental = spawnSync(process.execPath, [wrapper, ...args], { env, encoding: 'utf8' })
  assert.equal(incremental.status, 23, incremental.stderr)
  assert.deepEqual(JSON.parse(incremental.stdout), { args: args.filter(arg => arg !== '--reset-cache'), token: 'inherited' })
  const reset = spawnSync(process.execPath, [wrapper, ...args], {
    env: { ...env, SINGZ_METRO_RESET_CACHE: '1' }, encoding: 'utf8',
  })
  assert.equal(reset.status, 23, reset.stderr)
  assert.deepEqual(JSON.parse(reset.stdout), { args, token: 'inherited' })
  if (process.platform !== 'win32') {
    const signaled = spawnSync(process.execPath, [wrapper, ...args], {
      env: { ...env, SINGZ_FIXTURE_SIGNAL: 'SIGTERM' }, encoding: 'utf8',
    })
    assert.equal(signaled.status, null)
    assert.equal(signaled.signal, 'SIGTERM')
  }
})

test('legacy Android launcher delegates compiler identity and PCH policy without losing args', posixOnly, t => {
  const directory = fixture(t)
  mkdirSync(join(directory, 'mobile/scripts'), { recursive: true })
  mkdirSync(join(directory, 'scripts'))
  for (const relative of ['mobile/scripts/android-ccache-launcher.sh', 'scripts/ccache-launcher.sh'])
    copyFileSync(join(root, relative), join(directory, relative))
  const inspector = join(directory, 'compiler-inspector.cjs')
  writeFileSync(inspector, `
    console.log(JSON.stringify({ args: process.argv.slice(2),
      base: process.env.CCACHE_BASEDIR, nohash: process.env.CCACHE_NOHASHDIR,
      compiler: process.env.CCACHE_COMPILERCHECK, sloppy: process.env.CCACHE_SLOPPINESS }));
    process.exitCode = 17;
  `)
  const result = spawnSync('/bin/sh', [join(directory, 'mobile/scripts/android-ccache-launcher.sh'),
    process.execPath, directory, inspector, '-DVALUE=a b', 'literal;argument'], {
    env: { ...process.env, CCACHE_SLOPPINESS: 'locale,pch_defines', CCACHE_BASEDIR: '/stale/checkout' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 17, result.stderr)
  const actual = JSON.parse(result.stdout)
  assert.deepEqual(actual.args, ['-DVALUE=a b', 'literal;argument'])
  assert.equal(actual.base, directory)
  assert.equal(actual.nohash, '1')
  assert.equal(actual.compiler, 'content')
  assert.deepEqual(actual.sloppy.split(','), ['locale', 'pch_defines', 'time_macros'])
})

function runPolicy(directory, jobs, windows = false) {
  // Script mode runs only CMake policy evaluation: no configure, compiler,
  // Ninja graph, shared native build lock, or project dependencies are used.
  const script = join(directory, 'policy.cmake')
  const cmakePath = value => value.replace(/\\/g, '/')
  writeFileSync(script, `
set(SINGZ_ANDROID_BUILD_POLICY_HASH fixture)
set(SINGZ_ANDROID_NATIVE_MAX_JOBS "${jobs}" CACHE STRING "")
set(SINGZ_ANDROID_CCACHE_EXECUTABLE "${cmakePath(process.execPath)}")
set(CMAKE_HOST_WIN32 ${windows ? 'TRUE' : 'FALSE'})
include("${cmakePath(join(root, 'mobile/scripts/android-cmake-init.cmake'))}")
get_property(pools GLOBAL PROPERTY JOB_POOLS)
message("LAUNCHER=\${CMAKE_CXX_COMPILER_LAUNCHER}")
message("C_LAUNCHER=\${CMAKE_C_COMPILER_LAUNCHER}")
message("POOLS=\${pools}")
message("RN_WRAPPER=\${CCACHE_FOUND}")
`)
  return spawnSync('cmake', ['-P', script], { encoding: 'utf8' })
}

test('Android CMake selects one common launcher and bounded compile/link pool on both hosts', {
  skip: !cmakeAvailable && 'CMake is unavailable for policy-only checks',
}, t => {
  const directory = fixture(t)
  for (const windows of [false, true]) {
    const result = runPolicy(directory, '8', windows)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stderr, windows ? /scripts\/ccache-launcher\.ps1/ : /scripts\/ccache-launcher\.sh/)
    assert.doesNotMatch(result.stderr, /android-ccache-launcher/)
    assert.match(result.stderr, windows ? /POOLS=singz_android_native_pool=2/ : /POOLS=singz_android_native_pool=4/)
    assert.match(result.stderr, /RN_WRAPPER=OFF/)
    const launchers = result.stderr.split('\n').filter(line => /^(LAUNCHER|C_LAUNCHER)=/.test(line))
    assert.equal(launchers.length, 2)
    assert.equal(launchers[0].slice(launchers[0].indexOf('=')), launchers[1].slice(launchers[1].indexOf('=')))
  }
})

test('Android CMake rejects malformed or excessive native budgets', {
  skip: !cmakeAvailable && 'CMake is unavailable for policy-only checks',
}, t => {
  const directory = fixture(t)
  for (const jobs of ['0', '9', '100', '1.5', 'unbounded']) {
    const result = runPolicy(directory, jobs)
    assert.notEqual(result.status, 0, jobs)
    assert.match(result.stderr, /must be an integer from 1 through 8/)
  }
})

function dependencyFixture(t) {
  const directory = fixture(t)
  const skia = join(directory, 'node_modules/@shopify/react-native-skia/android/build.gradle')
  const audio = join(directory, 'node_modules/react-native-audio-api/android/build.gradle')
  for (const file of [skia, audio]) mkdirSync(join(file, '..'), { recursive: true })
  // Pinned upstream process shapes, independent from the patcher's replacement
  // table. Extra surrounding logic must survive patching byte for byte.
  writeFileSync(skia, `// untouched Skia prefix
static def resolveNodePackage(packageName, baseDir) {
  def script = "resolve package"
  def proc = ["node", "-e", script].execute(null, baseDir)
  proc.waitFor()
  if (proc.exitValue() != 0) {
    throw new GradleException("unresolved package" + proc.err.text)
  }
  return proc.text.trim()
}
// untouched Skia suffix
`)
  writeFileSync(audio, `// untouched AudioAPI prefix
def resolveReactNativeDirectory() {
  def reactNativePackage = file(["node", "--print", "require.resolve('react-native/package.json')"].execute(null, rootDir).text.trim())
  return reactNativePackage.parentFile
}
def validateWorkletsVersion() {
  try {
    def process = ["node", validationScript.absolutePath].execute()
    process.waitForProcessOutput(System.out, System.err)
    def exitCode = process.exitValue()
    if (exitCode == 0) {
      return true
    } else {
      logger.warn("[AudioAPI] Worklets version validation failed")
      return false
    }
  } catch (Exception e) {
    logger.error("[AudioAPI] Failed to validate worklets version")
    return false
  }
}
// untouched AudioAPI suffix
`)
  writeFileSync(audio, readFileSync(audio, 'utf8') + String.raw`
task downloadPrebuiltBinaries(type: Exec) {
  def isWindows = Os.isFamily(Os.FAMILY_WINDOWS)
  if (isWindows) {
    commandLine 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', '../scripts/download-prebuilt-binaries.sh', 'android', isFFmpegDisabled() ? 'skipffmpeg' : ''
  } else {
    commandLine 'chmod', '+x', '../scripts/download-prebuilt-binaries.sh'
    commandLine 'bash', '../scripts/download-prebuilt-binaries.sh', 'android', isFFmpegDisabled() ? 'skipffmpeg' : ''
  }
  environment 'DISABLE_AUDIOAPI_STATIC_EXTERNAL_LIBS', isStaticExternalLibsDisabled() ? '1' : '0'
}
// Keep the dependency edge: do not disable or skip the download task.
tasks.preBuild { dependsOn downloadPrebuiltBinaries }
`)
  return { directory, skia, audio }
}

test('dependency Gradle process patches preserve validators and do not rewrite on rerun', t => {
  const f = dependencyFixture(t)
  assert.equal(patchGradleCaches(f.directory), 2)
  const skia = readFileSync(f.skia, 'utf8')
  const audio = readFileSync(f.audio, 'utf8')
  assert.ok(skia.startsWith('// untouched Skia prefix\n'))
  assert.ok(skia.endsWith('// untouched Skia suffix\n'))
  assert.ok(audio.startsWith('// untouched AudioAPI prefix\n'))
  assert.ok(audio.includes('// untouched AudioAPI suffix\n'))
  assert.match(skia, /def resolveNodePackage\(packageName, baseDir\)/)
  assert.doesNotMatch(skia, /static def resolveNodePackage/)
  assert.match(skia, /providers\.exec/)
  assert.match(skia, /if \(proc\.result\.get\(\)\.exitValue != 0\)/)
  assert.match(skia, /proc\.standardError\.asText\.get\(\)/)
  assert.equal((audio.match(/providers\.exec/g) || []).length, 2)
  assert.match(audio, /ignoreExitValue = true/)
  assert.match(audio, /System\.out\.print\(validationOutput\)/)
  assert.match(audio, /System\.err\.print\(validationErrors\)/)
  assert.match(audio, /if \(exitCode == 0\)/)
  assert.match(audio, /logger\.warn\("\[AudioAPI\] Worklets version validation failed"\)/)
  assert.doesNotMatch(skia + audio, /\.execute\(|waitForProcessOutput/)
  assert.match(audio, /commandLine\('node', rootProject\.file\('\.\.\/\.\.\/scripts\/restore-audio-api-prebuilts\.cjs'\)\.absolutePath, 'android', isFFmpegDisabled\(\) \? 'skipffmpeg' : ''\)/)
  assert.doesNotMatch(audio, /download-prebuilt-binaries\.sh/)
  assert.match(audio, /environment 'DISABLE_AUDIOAPI_STATIC_EXTERNAL_LIBS', isStaticExternalLibsDisabled\(\) \? '1' : '0'/)
  assert.match(audio, /tasks\.preBuild \{ dependsOn downloadPrebuiltBinaries \}/)
  const firstTimes = [statSync(f.skia).mtimeMs, statSync(f.audio).mtimeMs]
  assert.equal(patchGradleCaches(f.directory), 0)
  assert.equal(readFileSync(f.skia, 'utf8'), skia)
  assert.equal(readFileSync(f.audio, 'utf8'), audio)
  assert.deepEqual([statSync(f.skia).mtimeMs, statSync(f.audio).mtimeMs], firstTimes)
})

test('dependency Gradle patch refuses upstream drift without partially editing other files', t => {
  const f = dependencyFixture(t)
  const skiaBefore = readFileSync(f.skia, 'utf8')
  const changedAudio = readFileSync(f.audio, 'utf8').replace('"--print"', '"--changed-upstream"')
  writeFileSync(f.audio, changedAudio)
  assert.throws(() => patchGradleCaches(f.directory), /upstream changed.*react-native-audio-api/)
  assert.equal(readFileSync(f.skia, 'utf8'), skiaBefore)
  assert.equal(readFileSync(f.audio, 'utf8'), changedAudio)
})

test('dependency Gradle patch refuses altered patched code and duplicate anchors', t => {
  const f = dependencyFixture(t)
  patchGradleCaches(f.directory)
  const originalPatchedAudio = readFileSync(f.audio, 'utf8')
  const changedSkia = readFileSync(f.skia, 'utf8').replace('proc.standardError.asText.get()', 'proc.changedUpstream.get()')
  writeFileSync(f.skia, changedSkia)
  assert.throws(() => patchGradleCaches(f.directory), /upstream changed.*react-native-skia/)
  assert.equal(readFileSync(f.audio, 'utf8'), originalPatchedAudio)
  const duplicate = dependencyFixture(t)
  writeFileSync(duplicate.skia, readFileSync(duplicate.skia, 'utf8') + '  return proc.text.trim()\n')
  assert.throws(() => patchGradleCaches(duplicate.directory), /upstream changed.*react-native-skia/)
})

test('dependency downloader patch refuses drift before touching resolver files', t => {
  const f = dependencyFixture(t)
  const skia = readFileSync(f.skia, 'utf8')
  const audio = readFileSync(f.audio, 'utf8').replace("'skipffmpeg'", "'changed-upstream-option'")
  writeFileSync(f.audio, audio)
  assert.throws(() => patchGradleCaches(f.directory), /upstream changed.*react-native-audio-api/)
  assert.equal(readFileSync(f.skia, 'utf8'), skia)
  assert.equal(readFileSync(f.audio, 'utf8'), audio)
})


test('dependency Gradle patch rejects an obsolete downloader patch that drops skip flags', t => {
  const f = dependencyFixture(t)
  patchGradleCaches(f.directory)
  const previous = readFileSync(f.audio, 'utf8').replace(
    ", 'android', isFFmpegDisabled() ? 'skipffmpeg' : '')",
    ", 'android')",
  )
  writeFileSync(f.audio, previous)
  assert.throws(() => patchGradleCaches(f.directory), /upstream changed.*react-native-audio-api/)
  assert.equal(readFileSync(f.audio, 'utf8'), previous)
})
