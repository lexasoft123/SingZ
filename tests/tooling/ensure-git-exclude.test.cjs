const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

const script = resolve(__dirname, '../../scripts/ensure-git-exclude.cjs')
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

test('parallel writers neither duplicate nor lose lines', async (t) => {
  const dir = scratch(t)
  const file = join(dir, 'exclude')
  writeFileSync(file, '# pre-existing\n*.swp\n')
  const shared = ['# worktree-setup provisioning links', 'vendor', 'gdrive.config.json', 'local.properties']
  const writers = Array.from({ length: 16 }, (_, index) =>
    spawn(process.execPath, [script, file, ...shared, `own-${index}`], { stdio: 'ignore' }))
  const exits = writers.map(writer => once(writer, 'exit'))
  for (const exit of exits) assert.equal((await exit)[0], 0)
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(new Set(lines).size, lines.length, `duplicates in:\n${lines.join('\n')}`)
  for (const line of ['# pre-existing', '*.swp', ...shared, ...writers.map((_, index) => `own-${index}`)])
    assert.ok(lines.includes(line), `lost ${line}`)
  assert.equal(lines.length, 2 + shared.length + writers.length)
  assert.deepEqual(readdirSync(dir), ['exclude'], 'no temp file or mutex is left behind')
})

test('a mutex abandoned by a crashed writer is taken over after it goes stale', (t) => {
  const dir = scratch(t)
  const file = join(dir, 'exclude')
  const mutex = `${file}.lock`
  require('node:fs').mkdirSync(mutex)
  const old = new Date(Date.now() - 120_000)
  require('node:fs').utimesSync(mutex, old, old)
  assert.deepEqual(ensureExcludeLines(file, ['vendor']), ['vendor'])
  assert.equal(existsSync(mutex), false)
})
