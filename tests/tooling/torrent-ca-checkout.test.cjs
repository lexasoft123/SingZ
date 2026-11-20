const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { test } = require('node:test')

const repo = resolve(__dirname, '../..')
const certificatePath = 'third_party/torrent/cacert.pem'
const attributes = readFileSync(join(repo, '.gitattributes'), 'utf8')
// Read the committed security asset, not bytes already converted in a caller's
// Windows working tree. This operation never mutates the application repository.
const canonical = execFileSync('git', ['show', 'HEAD:' + certificatePath], { cwd: repo })
const pin = readFileSync(join(repo, 'scripts/vendor-torrent.py'), 'utf8')
  .match(/^CA_SHA256\s*=\s*["']([a-f0-9]{64})["']/m)?.[1]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function checkout(t, attributeText) {
  const root = mkdtempSync(join(tmpdir(), 'singz pinned CA checkout '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const emptyConfig = join(root, 'empty.gitconfig')
  const emptyAttributes = join(root, 'empty.attributes')
  writeFileSync(emptyConfig, '')
  writeFileSync(emptyAttributes, '')
  const env = { ...process.env }
  // A caller's selectors, object directories or injected config must not aim
  // fixture-only mutations at its real repository. No remote is used here.
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig })
  const git = args => execFileSync('git', args, {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  })
  git(['init', '-q'])
  git(['config', 'core.attributesFile', emptyAttributes])
  git(['config', 'core.autocrlf', 'false'])
  git(['config', 'core.eol', 'lf'])
  git(['config', 'core.safecrlf', 'false'])
  writeFileSync(join(root, '.gitattributes'), attributeText)
  mkdirSync(dirname(join(root, certificatePath)), { recursive: true })
  writeFileSync(join(root, certificatePath), canonical)
  writeFileSync(join(root, 'control.txt'), 'ordinary checkout text\nsecond line\n')
  mkdirSync(join(root, '.githooks'))
  writeFileSync(join(root, '.githooks/fixture-hook'), '#!/bin/sh\nexit 0\n')
  git(['add', '--', '.gitattributes', certificatePath, 'control.txt', '.githooks/fixture-hook'])
  git(['config', 'core.autocrlf', 'true'])
  git(['config', 'core.eol', 'crlf'])
  // Force a genuine checkout instead of Git's unchanged-stat shortcut.
  for (const file of [certificatePath, 'control.txt', '.githooks/fixture-hook']) rmSync(join(root, file))
  git(['checkout-index', '--all', '--force'])
  assert.match(readFileSync(join(root, 'control.txt'), 'utf8'), /\r\n/,
    'The fixture must actually perform CRLF conversion')
  assert.equal(readFileSync(join(root, '.githooks/fixture-hook'), 'utf8'), '#!/bin/sh\nexit 0\n',
    'The other application attributes must remain in effect')
  return readFileSync(join(root, certificatePath))
}

test('CRLF-configured Git checkout preserves the pinned torrent CA bytes', t => {
  assert.ok(pin, 'The actual vendor script must expose its pinned SHA-256')
  assert.equal(sha256(canonical), pin, 'The repository CA blob must match the strict vendor pin')
  const checkedOut = checkout(t, attributes)
  assert.deepEqual(checkedOut, canonical)
  assert.equal(sha256(checkedOut), pin)
})

test('removing the CA checkout rule reproduces the Windows checksum failure', t => {
  const withoutProtection = attributes.replace(/^third_party\/torrent\/cacert\.pem\s+-text\r?$/m, '')
  assert.notEqual(withoutProtection, attributes, 'The negative control must remove the asset rule')
  const converted = checkout(t, withoutProtection)
  assert.match(converted.toString('utf8'), /\r\n/)
  assert.notEqual(sha256(converted), pin, 'CRLF-converted bytes must fail the unchanged security pin')
})
