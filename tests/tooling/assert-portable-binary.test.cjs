'use strict'
// Executable checks for scripts/assert-portable-binary.sh's Linux ELF identity
// gate: the script must read the binary's own class/machine, not trust the
// vendor/<target> path it was handed — a mislabeled cached helper passes every
// NEEDED/RPATH check on a matching host and only fails on the board itself.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')

const repository = resolve(__dirname, '../..')
const script = join(repository, 'scripts/assert-portable-binary.sh')
// POSIX-only fixtures, same convention as engine-artifact.test.cjs: the gate
// is a shell script, the fixtures are ELF files, and the missing-readelf case
// symlinks /usr/bin tools — none of which exists on a Windows host. Skipping
// here loses nothing: the real gate runs wherever the vendors build.
const posixOnly = { skip: process.platform === 'win32'
  ? 'ELF gate fixtures are POSIX shell executables; the helper check runs on every host'
  : false }

const EM_X86_64 = 62
const EM_AARCH64 = 183

// Tool resolution stays off module scope: on Windows there is no bash to
// resolve, and a module-level spawnSync('bash', ...) would fail before the
// skip option can apply. The ternary short-circuits the readelf probe there.
const readelfSkip = process.platform === 'win32' ? false
  : spawnSync('bash', ['-c', 'command -v readelf || true'], { encoding: 'utf8' }).stdout.trim()
    ? false
    : 'GNU readelf is not installed on this host (binutils); the ELF identity assertions run on the Linux CI/VM hosts'
const elfIdentityOnly = { skip: posixOnly.skip || readelfSkip || false }

let resolvedBash = ''
function bash() {
  if (!resolvedBash) resolvedBash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
  return resolvedBash
}

function writeElfHeader(file, { machine, elfClass = 2, data = 1 } = {}) {
  const bytes = Buffer.alloc(64)
  bytes[0] = 0x7f; bytes[1] = 0x45; bytes[2] = 0x4c; bytes[3] = 0x46
  bytes[4] = elfClass // EI_CLASS: 1 = 32-bit, 2 = 64-bit
  bytes[5] = data     // EI_DATA: 1 = little endian
  bytes[6] = 1        // EI_VERSION
  bytes.writeUInt16LE(2, 16)       // e_type = ET_EXEC
  bytes.writeUInt16LE(machine, 18) // e_machine
  bytes.writeUInt32LE(1, 20)       // e_version
  bytes.writeUInt16LE(64, 52)      // e_ehsize
  writeFileSync(file, bytes)
}

function runCheck(target, file, env = process.env) {
  // The script deletes a binary it rejects; callers that assert a rejection
  // rewrite the fixture afterwards if they need it again.
  return spawnSync(bash(), [script, target, file], { encoding: 'utf8', env })
}

test('Linux check fails closed when readelf is unavailable', posixOnly, t => {
  const directory = mkdtempSync(join(tmpdir(), 'singz-elf-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  // A real bin directory with the tools the script's cleanup path shells out
  // to — and no readelf. A bare nonexistent PATH would make the whole case
  // about the spawn failing, not about the gate firing.
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  for (const tool of ['rm', 'sed', 'grep', 'basename']) {
    const resolved = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
    assert.ok(resolved, `${tool} must exist on the host to build the stub PATH`)
    symlinkSync(resolved, join(bin, tool))
  }
  const file = join(directory, 'engine')
  writeElfHeader(file, { machine: EM_AARCH64 })
  const result = runCheck('linux-arm64', file, { ...process.env, PATH: bin })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /readelf is required/)
  assert.equal(existsSync(file), false, 'an unverifiable binary must not be left behind')
})

test('Linux ELF identity accepts a binary matching the target machine', elfIdentityOnly, t => {
  const directory = mkdtempSync(join(tmpdir(), 'singz-elf-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const [target, machine] of [['linux-x64', EM_X86_64], ['linux-arm64', EM_AARCH64]]) {
    const file = join(directory, `engine-${target}`)
    writeElfHeader(file, { machine })
    const result = runCheck(target, file)
    assert.equal(result.status, 0, `${target}: ${result.stderr}`)
    assert.equal(existsSync(file), true)
  }
})

test('Linux ELF identity rejects a mislabeled foreign-architecture helper', elfIdentityOnly, t => {
  const directory = mkdtempSync(join(tmpdir(), 'singz-elf-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  // The exact failure mode the gate exists for: an x64 helper sitting in the
  // arm64 cache directory (or the reverse) — every library-hygiene check
  // passes on the build host, the board gets an exec format error.
  const file = join(directory, 'engine')
  writeElfHeader(file, { machine: EM_X86_64 })
  let result = runCheck('linux-arm64', file)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ELF identity.*AArch64/)
  assert.equal(existsSync(file), false, 'rejected helper must be removed, not left for the cache skip-guard')
  writeElfHeader(file, { machine: EM_AARCH64 })
  result = runCheck('linux-x64', file)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /ELF identity.*X86-64/)
  assert.equal(existsSync(file), false)
})

test('Linux ELF identity rejects 32-bit and big-endian impostors', elfIdentityOnly, t => {
  const directory = mkdtempSync(join(tmpdir(), 'singz-elf-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'engine')
  writeElfHeader(file, { machine: EM_AARCH64, elfClass: 1 })
  let result = runCheck('linux-arm64', file)
  assert.notEqual(result.status, 0, '32-bit fixture must be rejected')
  assert.match(result.stderr, /ELF identity/)
  writeElfHeader(file, { machine: EM_AARCH64, data: 2 })
  result = runCheck('linux-arm64', file)
  assert.notEqual(result.status, 0, 'big-endian fixture must be rejected')
  assert.match(result.stderr, /ELF identity/)
})

test('non-ELF input is rejected, not silently passed', elfIdentityOnly, t => {
  const directory = mkdtempSync(join(tmpdir(), 'singz-elf-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'engine')
  writeFileSync(file, '#!/bin/sh\necho not an elf\n')
  const result = runCheck('linux-arm64', file)
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(file), false)
})
