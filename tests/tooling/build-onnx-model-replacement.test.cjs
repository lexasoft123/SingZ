'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')

const script = fs.readFileSync(resolve(__dirname, '../../scripts/build-onnx-pack.sh'), 'utf8')
const replacement = script.match(/^  \(\n    MODEL_REPLACEMENT=\$\(mktemp [\s\S]*?^  \)/m)?.[0]
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX pack script' : false }

function fixture(t) {
  assert.ok(replacement, 'production atomic replacement block exists')
  const root = fs.mkdtempSync(join(tmpdir(), 'singz-model-replacement-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const blob = join(root, 'shared-blob')
  const model = join(root, 'cached-model.onnx')
  const slim = join(root, 'slim.onnx')
  fs.writeFileSync(blob, 'original shared graph', { mode: 0o444 })
  fs.linkSync(blob, model)
  fs.writeFileSync(slim, 'validated slim graph')
  return { root, blob, model, slim }
}

function run(f, block, bin) {
  return spawnSync('bash', ['-e', '-c', block], {
    encoding: 'utf8',
    env: { ...process.env, MODEL_FILE: f.model, TRT_MODEL: f.slim,
      PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH }
  })
}

function assertOriginal(f) {
  assert.equal(fs.readFileSync(f.blob, 'utf8'), 'original shared graph')
  assert.equal(fs.statSync(f.blob).mode & 0o777, 0o444)
}

function assertNoTemporary(f) {
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.includes('.slim.')), [])
}

test('real pack replacement preserves a read-only shared blob and installs a readable new inode', posixOnly, t => {
  const f = fixture(t)
  const originalInode = fs.statSync(f.model).ino
  const result = run(f, replacement)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(f.model, 'utf8'), 'validated slim graph')
  assert.notEqual(fs.statSync(f.model).ino, originalInode)
  assert.equal(fs.statSync(f.model).mode & 0o777, 0o644)
  assertOriginal(f)
  assertNoTemporary(f)
})

test('failed copy leaves the original entry untouched and removes the temporary file', posixOnly, t => {
  const f = fixture(t)
  const bin = join(f.root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(join(bin, 'cp'), '#!/bin/sh\nprintf partial > "$2"\nexit 23\n', { mode: 0o755 })
  const result = run(f, replacement, bin)
  assert.equal(result.status, 23)
  assert.equal(fs.statSync(f.model).ino, fs.statSync(f.blob).ino)
  assertOriginal(f)
  assertNoTemporary(f)
})

test('negative control rejects the old in-place copy against a read-only cache entry', posixOnly, t => {
  const f = fixture(t)
  const result = run(f, 'cp "$TRT_MODEL" "$MODEL_FILE"')
  if (process.getuid?.() === 0) {
    // Root can overwrite 0444 files, but the hardlinked shared blob then
    // changes too: the original behavior still violates the invariant.
    assert.notEqual(fs.readFileSync(f.blob, 'utf8'), 'original shared graph')
  } else {
    assert.notEqual(result.status, 0)
    assertOriginal(f)
  }
})
