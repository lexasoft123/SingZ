const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

// The override runs the suite against a preserved older implementation.
const script = process.env.SINGZ_TEST_EXCLUDE_SCRIPT || resolve(__dirname, '../../scripts/ensure-git-exclude.cjs')
const { ensureExcludeLines } = require(script)

function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'singz-exclude-test-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('adds only missing lines, keeps existing content, and is idempotent', (t) => {
  const file = join(scratch(t), 'info', 'exclude')
  assert.deepEqual(ensureExcludeLines(file, ['vendor', 'a', 'a']), ['vendor', 'a'])
  writeFileSync(file, '# user rule\n*.log\nvendor') // no trailing newline
  assert.deepEqual(ensureExcludeLines(file, ['vendor', 'local.properties']), ['local.properties'])
  assert.equal(readFileSync(file, 'utf8'), '# user rule\n*.log\nvendor\nlocal.properties\n')
  assert.deepEqual(ensureExcludeLines(file, ['vendor', 'local.properties']), [])
})

test('16 parallel writers with distinct lines lose nothing and duplicate nothing', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'exclude')
  writeFileSync(file, '# pre-existing\n*.swp\n')
  const mine = (index) => Array.from({ length: 12 }, (_, n) => `writer-${index}/line-${n}`)
  const shared = []
  const writers = Array.from({ length: 16 }, (_, index) =>
    spawn(process.execPath, [script, file, ...shared, ...mine(index)], { stdio: 'ignore' }))
  const exits = writers.map(writer => once(writer, 'exit'))
  for (const exit of exits) assert.equal((await exit)[0], 0)
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(new Set(lines).size, lines.length, `duplicates in:\n${lines.join('\n')}`)
  const expected = ['# pre-existing', '*.swp', ...shared, ...writers.flatMap((_, index) => mine(index))]
  for (const line of expected) assert.ok(lines.includes(line), `lost ${line}`)
  assert.equal(lines.length, expected.length)
  assert.deepEqual(readdirSync(dir), ['exclude'], 'no temp file or lock is left behind')
})

test('a lock directory left by a crashed writer neither blocks nor is needed', (t) => {
  const dir = scratch(t)
  const file = join(dir, 'exclude')
  // The old implementation serialized on `<file>.lock` and waited 30 seconds
  // for a crashed writer's directory to age out. Nothing may wait on it now.
  require('node:fs').mkdirSync(`${file}.lock`)
  const started = Date.now()
  const result = require('node:child_process').spawnSync(process.execPath, [script, file, 'vendor'],
    { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, `${result.error ?? ''}${result.stderr}`)
  assert.ok(Date.now() - started < 5000, 'the writer must not wait for a lock directory')
  assert.equal(readFileSync(file, 'utf8'), 'vendor\n')
})
