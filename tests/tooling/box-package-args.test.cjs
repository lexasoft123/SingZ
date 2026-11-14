'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const repository = resolve(__dirname, '../..')
const {
  electronBuilderArgs,
  parseDistRequest
} = require(join(repository, 'scripts/dist.cjs'))

test('Desktop request parsing and builder arguments remain unchanged', () => {
  const input = ['--linux', '--x64']
  const request = parseDistRequest(input, 'linux', 'x64')
  assert.deepEqual(request, {
    args: ['--linux', '--x64'],
    box: false,
    targets: ['linux-x64']
  })
  assert.deepEqual(input, ['--linux', '--x64'])
  assert.deepEqual(electronBuilderArgs(request.args, request.box), [
    '--linux', '--x64', '--publish', 'never'
  ])
})

test('Box selector is consumed once and selects only the fixed trusted config', () => {
  const request = parseDistRequest(['--box', '--linux', '--arm64'], 'linux', 'arm64')
  assert.deepEqual(request, {
    args: ['--linux', '--arm64'],
    box: true,
    targets: ['linux-arm64']
  })
  assert.deepEqual(electronBuilderArgs(request.args, request.box), [
    '--linux', '--arm64',
    '--config', 'electron-builder.box.yml',
    '--publish', 'never'
  ])
  assert.deepEqual(electronBuilderArgs(['--linux', '--publish', 'always'], true), [
    '--linux', '--publish', 'always', '--config', 'electron-builder.box.yml'
  ])
})

test('unsafe Box overrides and architecture bypasses fail during request parsing', () => {
  const rejected = [
    ['-c'], ['-c=other.yml'], ['-c.other.yml'], ['-cfoo'],
    ['--config'], ['--config=other.yml'], ['--config.other.yml'],
    ['--prepackaged'], ['--prepackaged=dist/old'], ['--pd'], ['--pd=dist/old'],
    ['--project'], ['--project=elsewhere'],
    ['--projectDir'], ['--projectDir=elsewhere'], ['--projectDir.foo=bar'],
    ['deb:arm64'], ['linux:x64'], ['--x64=false'], ['--no-arm64'],
    ['--ia32'], ['--armv7l'], ['--universal'],
    ['--box'], ['--box=true'], ['--box.selector=box'], ['--no-box']
  ]
  for (const args of rejected) {
    assert.throws(
      () => parseDistRequest(['--box', '--linux', ...args], 'linux', 'x64'),
      undefined,
      args.join(' ')
    )
  }
})

test('package scripts route only Box through the internal selector and Linux target', () => {
  const metadata = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
  assert.equal(metadata.scripts.dist, 'node scripts/dist.cjs')
  assert.equal(metadata.scripts['dist:box'], 'node scripts/dist.cjs --box --linux')
})

function assertFlatMainChunkFileNames(pattern) {
  assert.equal(typeof pattern, 'string', 'main chunkFileNames must be configured')
  assert.ok(!pattern.includes('/'), 'main dynamic chunks must not be emitted in a subdirectory')
  assert.equal(pattern, '[name]-[hash].js')
}

test('main bootstrap is emitted as index and keeps dynamic chunks in the flat main directory', () => {
  const source = readFileSync(join(repository, 'electron.vite.config.ts'), 'utf8').replace(/\r\n/g, '\n')
  const main = source.match(/main:\s*\{([\s\S]*?)\n      \},\n      preload:/)?.[1]
  assert.ok(main, 'main Vite config must remain present for Desktop and development builds')
  assert.match(main, /rollupOptions:\s*\{/)
  assert.match(main,
    /input:\s*\{\s*index:\s*resolve\(import\.meta\.dirname,\s*'src\/main\/bootstrap\.ts'\)\s*,/
  )
  assert.match(main, /'audio-service':\s*resolve\(import\.meta\.dirname,\s*'src\/main\/audio-service\.ts'\)/)
  const chunkFileNames = main.match(/\bchunkFileNames:\s*'([^']+)'/)?.[1]
  assertFlatMainChunkFileNames(chunkFileNames)
  assert.doesNotMatch(main, /\boutDir\s*:/)
  assert.throws(
    () => assertFlatMainChunkFileNames('chunks/[name]-[hash].js'),
    /main dynamic chunks must not be emitted in a subdirectory/
  )
})
