'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')
const { test } = require('node:test')

const repoRoot = resolve(__dirname, '../..')
const zcoreRoot = join(repoRoot, 'third_party', 'zcore')

function assertTargetHasPrivateRoot(cmake, target, rootVariable) {
  const match = cmake.match(new RegExp(
    `target_include_directories\\s*\\(\\s*${target}\\s+PRIVATE([\\s\\S]*?)\\)`))
  assert.ok(match, `missing PRIVATE include declaration for ${target}`)
  assert.ok(match[1].includes(rootVariable),
    `${target} must privately include ${rootVariable} for zCore provider headers`)
}

function compileHeader(header, includeRoots, directory, compiler) {
  const source = join(directory, 'header-check.cpp')
  writeFileSync(source, `#include <${header}>\nint main() { return 0; }\n`)
  const isMsvc = /^(?:clang-cl|cl)(?:\.exe)?$/i.test(basename(compiler))
  const args = isMsvc
    ? ['/nologo', '/std:c++20', '/Zs', source, ...includeRoots.map((root) => `/I${root}`)]
    : ['-std=c++20', '-fsyntax-only', source,
      ...includeRoots.flatMap((root) => ['-I', root])]
  return spawnSync(compiler, args, { encoding: 'utf8' })
}

test('desktop and Android bindings declare private zCore source-root includes', () => {
  const desktopCmake = require('node:fs').readFileSync(join(repoRoot, 'CMakeLists.txt'), 'utf8')
  const androidCmake = require('node:fs').readFileSync(
    join(repoRoot, 'mobile/android/app/src/main/cpp/CMakeLists.txt'), 'utf8')
  assertTargetHasPrivateRoot(desktopCmake, 'singz_capture', '${ZCORE_ROOT}')
  assertTargetHasPrivateRoot(androidCmake, 'singzcore', '${SINGZ_AUDIO_ENGINE_ROOT}')
})

test('platform provider headers resolve only when zCore source root is included', (t) => {
  const candidates = [...new Set([
    process.env.CXX,
    ...(process.platform === 'win32'
      ? ['clang-cl', 'cl', 'clang++', 'c++']
      : ['clang++', 'c++', 'g++']),
  ].filter(Boolean))]
  let compiler
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.error?.code !== 'ENOENT') {
      compiler = candidate
      break
    }
  }
  if (!compiler) {
    t.skip('no C++ compiler is available; CMake target assertions still ran')
    return
  }

  const scratch = mkdtempSync(join(tmpdir(), 'singz-provider-header-includes-'))
  try {
    for (const header of [
      'zcore/platform/android/audio_host_android_registry.h',
      'zcore/platform/android/audio_host_android_provider.h',
      'zcore/platform/windows/audio_host_windows_provider.h',
    ]) {
      const withRoot = compileHeader(header,
        [zcoreRoot, join(zcoreRoot, 'zcore/include')], scratch, compiler)
      assert.equal(withRoot.status, 0,
        `${header} should compile with ${compiler} and the zCore source root:\n${withRoot.stdout}${withRoot.stderr}`)

      // Negative control: the public zcore/include directory cannot resolve
      // these private platform-provider paths on its own.
      const withoutRoot = compileHeader(header,
        [join(zcoreRoot, 'zcore/include')], scratch, compiler)
      assert.notEqual(withoutRoot.status, 0,
        `${header} unexpectedly compiled without the zCore source root`)
      assert.match(`${withoutRoot.stdout}${withoutRoot.stdout}${withoutRoot.stderr}`, /file not found|No such file|cannot open .*file|C1083/i,
        `${header} must fail specifically because its source-root include is absent:\n${withoutRoot.stdout}${withoutRoot.stderr}`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
