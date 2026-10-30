const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repository = path.resolve(__dirname, '../..')
const has = name => spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name]).status === 0
const cmakeAvailable = has('cmake')
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX launcher probe; PowerShell launcher is exercised by Android CI' : false }

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'singz-compiler-cache-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr)
  return result.stdout.trim()
}
function sources(root) {
  fs.mkdirSync(path.join(root, 'cmake'), { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'))
  for (const name of ['ccache-launcher.sh', 'ccache-launcher.ps1'])
    fs.copyFileSync(path.join(repository, 'scripts', name), path.join(root, 'scripts', name))
  fs.copyFileSync(path.join(repository, 'cmake/SingZCompilerCache.cmake'), path.join(root, 'cmake/SingZCompilerCache.cmake'))
  fs.copyFileSync(path.join(repository, 'CMakePresets.json'), path.join(root, 'CMakePresets.json'))
}

test('common launcher preserves caller options and supplies worktree/PCH cache identity', posixOnly, t => {
  const directory = fixture(t)
  const probe = 'console.log(JSON.stringify({base:process.env.CCACHE_BASEDIR,hash:process.env.CCACHE_NOHASHDIR,compiler:process.env.CCACHE_COMPILERCHECK,sloppiness:process.env.CCACHE_SLOPPINESS,args:process.argv.slice(1)}))'
  const env = { ...process.env, CCACHE_SLOPPINESS: 'include_file_mtime,time_macros' }
  const result = execute('/bin/sh', [path.join(repository, 'scripts/ccache-launcher.sh'), process.execPath, directory, '-e', probe, 'argument with spaces'], { env })
  const observed = JSON.parse(result)
  assert.equal(observed.base, directory)
  assert.equal(observed.hash, '1')
  assert.equal(observed.compiler, 'content')
  assert.deepEqual(new Set(observed.sloppiness.split(',')), new Set(['include_file_mtime', 'pch_defines', 'time_macros']))
  assert.deepEqual(observed.args, ['argument with spaces'])
})

test('direct CMake configuration installs one launcher and preserves a foreign launcher', {
  skip: !cmakeAvailable ? 'CMake unavailable' : false,
}, t => {
  const directory = fixture(t)
  const root = path.join(directory, 'checkout')
  sources(root)
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.21)\nproject(CachePolicy NONE)\ninclude(cmake/SingZCompilerCache.cmake)\nsingz_enable_compiler_cache("\${CMAKE_CURRENT_SOURCE_DIR}")\n`)
  const build = path.join(root, 'build')
  execute('cmake', ['-S', root, '-B', build, `-DSINGZ_CCACHE_EXECUTABLE=${process.execPath}`])
  let cache = fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8')
  assert.match(cache, /CMAKE_CXX_COMPILER_LAUNCHER:STRING=.*ccache-launcher\.(sh|ps1)/)
  assert.match(cache, /CMAKE_C_COMPILER_LAUNCHER:STRING=.*ccache-launcher\.(sh|ps1)/)
  execute('cmake', ['-S', root, '-B', build, '-DCMAKE_CXX_COMPILER_LAUNCHER=foreign-compiler-launcher'])
  cache = fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8')
  assert.match(cache, /CMAKE_CXX_COMPILER_LAUNCHER:UNINITIALIZED=foreign-compiler-launcher/)
  execute('cmake', ['-S', root, '-B', build, '-DSINGZ_COMPILER_CACHE=OFF'])
  cache = fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8')
  assert.doesNotMatch(cache, /CMAKE_C_COMPILER_LAUNCHER:[^=]*=.*ccache-launcher/)
  assert.match(cache, /CMAKE_CXX_COMPILER_LAUNCHER:UNINITIALIZED=foreign-compiler-launcher/)
})

test('CMake compiler caching can be disabled and is optional when ccache is unavailable', {
  skip: !cmakeAvailable ? 'CMake unavailable' : false,
}, t => {
  const directory = fixture(t)
  const root = path.join(directory, 'checkout')
  sources(root)
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.21)\nproject(CachePolicy NONE)\ninclude(cmake/SingZCompilerCache.cmake)\nsingz_enable_compiler_cache("\${CMAKE_CURRENT_SOURCE_DIR}")\n`)
  for (const [name, args] of [
    ['disabled', ['-DSINGZ_COMPILER_CACHE=OFF']],
    ['absent', ['-DCMAKE_FIND_USE_SYSTEM_ENVIRONMENT_PATH=FALSE', '-DCMAKE_FIND_USE_CMAKE_SYSTEM_PATH=FALSE', '-DCMAKE_FIND_USE_CMAKE_ENVIRONMENT_PATH=FALSE', '-DCMAKE_FIND_USE_CMAKE_PATH=FALSE']],
  ]) {
    const build = path.join(root, name)
    const make = process.platform === 'win32' ? null : execute('which', ['make'])
    const generator = make ? ['-G', 'Unix Makefiles', `-DCMAKE_MAKE_PROGRAM=${make}`] : []
    execute('cmake', ['-S', root, '-B', build, ...generator, ...args])
    const cache = fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8')
    assert.doesNotMatch(cache, /CMAKE_CXX_COMPILER_LAUNCHER:[^=]*=.*ccache-launcher/)
  }
})

const nativeProbe = process.env.SINGZ_TEST_COMPILER_CACHE === '1' && process.platform !== 'win32' && cmakeAvailable && has('ccache')
for (const preset of ['host-debug', 'host-release']) {
  test(`${preset} reuses compiled objects in another checkout and invalidates changed source`, {
    skip: nativeProbe ? false : 'Set SINGZ_TEST_COMPILER_CACHE=1 and run under the shared native-build wrapper for real C++ probes',
  }, t => {
    // This test is opt-in because actual compilation must hold the repository's
    // global native lock. It never uses or resets the machine's shared cache.
    require('../../scripts/native-build-lock.cjs').assertNativeBuildLockHeld(repository, process.env.SINGZ_NATIVE_BUILD_LOCK_HELD)
    const directory = fixture(t)
    const conf = path.join(directory, 'ccache.conf')
    fs.writeFileSync(conf, 'max_size = 100M\n')
    const env = { ...process.env, CCACHE_CONFIGPATH: conf, CCACHE_DIR: path.join(directory, 'cache') }
    for (const key of ['CCACHE_BASEDIR', 'CCACHE_NOHASHDIR', 'CCACHE_COMPILERCHECK', 'CMAKE_C_COMPILER_LAUNCHER', 'CMAKE_CXX_COMPILER_LAUNCHER']) delete env[key]
    const stats = () => JSON.parse(execute('ccache', ['--print-stats', '--format=json'], { env }))
    const compile = root => {
      execute('cmake', ['--preset', preset], { cwd: root, env })
      execute('cmake', ['--build', '--preset', preset], { cwd: root, env })
    }
    for (const name of ['first', 'second']) {
      const root = path.join(directory, name)
      sources(root)
      fs.writeFileSync(path.join(root, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.21)\nproject(CacheProbe LANGUAGES CXX)\ninclude(cmake/SingZCompilerCache.cmake)\nsingz_enable_compiler_cache("\${CMAKE_CURRENT_SOURCE_DIR}")\nconfigure_file(config.h.in generated/config.h COPYONLY)\nadd_library(unit STATIC unit.cpp)\ntarget_include_directories(unit PRIVATE "\${CMAKE_BINARY_DIR}/generated")\n`)
      fs.writeFileSync(path.join(root, 'unit.cpp'), '#include "config.h"\nint meaning() { return VALUE; }\n')
      fs.writeFileSync(path.join(root, 'config.h.in'), '#define VALUE 42\n')
      compile(root)
      const counters = stats()
      if (name === 'first') {
        assert.equal(counters.direct_cache_hit + counters.preprocessed_cache_hit, 0)
        assert.equal(counters.cache_miss, 1)
      } else {
        assert.equal(counters.direct_cache_hit + counters.preprocessed_cache_hit, 1)
        assert.equal(counters.cache_miss, 1)
        fs.writeFileSync(path.join(root, 'unit.cpp'), '#include "config.h"\nint meaning() { return VALUE + 1; }\n')
        fs.rmSync(path.join(root, 'build/native', preset, 'CMakeFiles/unit.dir/unit.cpp.o'))
        execute('cmake', ['--build', '--preset', preset], { cwd: root, env })
        assert.equal(stats().cache_miss, 2)
      }
    }
  })
}
