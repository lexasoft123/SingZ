'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')

const python = ['python3', 'python'].find(command =>
  spawnSync(command, ['--version'], { timeout: 10_000 }).status === 0)
const options = { skip: python ? false : 'Python is unavailable' }

// Vite and bash package these programs without parsing Python. Compile the
// actual source files without importing optional ML packages or writing pyc.
function compile(files) {
  return spawnSync(python, ['-c',
    'import pathlib, sys; [compile(pathlib.Path(p).read_text(encoding="utf-8"), p, "exec") for p in sys.argv[1:]]',
    ...files], { encoding: 'utf8', timeout: 10_000 })
}

test('app-owned Python runners and the model exporter compile without ML dependencies', options, () => {
  const files = ['onnx_runner.py', 'mms_align.py', 'mms_align_onnx.py',
    'export_beat_onnx.py', 'vocal_split_runner.py', 'beat_runner.py']
    .map(file => resolve(__dirname, '../../scripts', file))
  const result = compile(files)
  assert.equal(result.status, 0, result.stderr)
})

test('the Python syntax gate rejects a broken runner before packaging', options, t => {
  const root = mkdtempSync(join(tmpdir(), 'singz-python-syntax-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const broken = join(root, 'broken.py')
  writeFileSync(broken, 'def broken(\n')
  const result = compile([broken])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SyntaxError/)
})
