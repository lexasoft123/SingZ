'use strict'
// The ONNX pack embeds a native CPython and pip-installs native wheels, so
// scripts/build-onnx-pack.sh must refuse a Linux target on any host that is
// not that same Linux architecture — before downloading anything. The
// original guard checked only `uname -m`, which an arm64 macOS host passes;
// the script then fetched the whole aarch64 python archive and died on exec.
// These cases run the real script bytes from an isolated fixture root (never
// this checkout, where cached packs legitimately exist) with a curl tripwire
// on PATH, and assert the guard diagnostic fires with no download attempted.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')

const repository = resolve(__dirname, '../..')
// POSIX-only fixtures, same convention as engine-artifact.test.cjs: the
// script is a bash program and the tripwire is a /bin/sh stub; Windows hosts
// run the same suite, so skip rather than emulate.
const posixOnly = { skip: process.platform === 'win32'
  ? 'build-onnx-pack.sh is a bash program; the guard check runs on every POSIX host'
  : false }

let resolvedBash = ''
function bash() {
  if (!resolvedBash) resolvedBash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  return resolvedBash
}

function host() {
  const parts = spawnSync('uname', ['-s', '-m'], { encoding: 'utf8' }).stdout.trim().split(/\s+/)
  return { system: parts[0], machine: parts[1] }
}

function matchingLinuxHost(target) {
  const { system, machine } = host()
  if (system !== 'Linux') return false
  if (target === 'linux-arm64') return machine === 'aarch64' || machine === 'arm64'
  return machine === 'x86_64'
}

// The script locates its work directory from its own path, so copying the
// real bytes into a temp tree runs them against a root where .engines-src
// cannot collide with a checkout's real caches — a correct guard refusal
// must never fail just because this machine once built a pack.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'singz-onnx-pack-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(join(repository, 'scripts', 'build-onnx-pack.sh'), join(root, 'scripts', 'build-onnx-pack.sh'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // Tripwire: a guard regression that reaches the download phase would call
  // curl; the stub records the attempt and fails, keeping the test offline
  // either way.
  const stubLog = join(root, 'curl-invocations.log')
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
echo "$@" >> "${stubLog}"
exit 1
`, { mode: 0o755 })
  return { root, bin, stubLog }
}

function runGuard(t, target) {
  const { root, bin, stubLog } = fixture(t)
  const result = spawnSync(bash(), [join(root, 'scripts', 'build-onnx-pack.sh'), target], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  })
  return { result, root, stubLog }
}

function assertGuardRefused(t, target) {
  const { result, root, stubLog } = runGuard(t, target)
  assert.notEqual(result.status, 0, 'the guard must fail the invocation')
  assert.match(result.stderr, /requires a matching native Linux/)
  assert.equal(existsSync(stubLog), false, 'curl must never run when the guard fires')
  assert.equal(
    existsSync(join(root, '.engines-src', `onnx-pack-${target}`)),
    false,
    'the guard must fire before the work directory (and download) is created'
  )
}

for (const target of ['linux-x64', 'linux-arm64']) {
  test(`${target} is rejected on a non-matching host before any download`, posixOnly, t => {
    if (matchingLinuxHost(target)) {
      t.skip(`this host is a matching ${target} build machine; the guard is expected to pass here and the real build is exercised by CI`)
      return
    }
    assertGuardRefused(t, target)
  })
}

// The precise regression: an Apple-silicon Mac reports `uname -m` = arm64,
// the same machine string ARM64 Linux builders give as `aarch64` — and its
// python still cannot exec an aarch64-unknown-linux-gnu interpreter. Every
// macOS host, arm64 included, must be refused for both Linux targets.
test('both Linux targets are refused on macOS hosts', posixOnly, t => {
  const { system } = host()
  if (system !== 'Darwin') {
    t.skip('macOS-only case; other non-Linux hosts cover their own paths above')
    return
  }
  assertGuardRefused(t, 'linux-x64')
  assertGuardRefused(t, 'linux-arm64')
})
