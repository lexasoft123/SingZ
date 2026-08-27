#!/usr/bin/env node

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const { machCanonicalSha256 } = require('../../scripts/capture-artifact.cjs')

if (process.platform !== 'darwin') throw new Error('Signed capture smoke requires macOS')
const root = resolve(__dirname, '../..')
const appPath = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Usage: capture-addon-signed-mac.cjs <SingZ.app>')
const addon = join(appPath, 'Contents', 'Resources', 'engines', 'singz-capture.node')
const expectedSha = readFileSync(`${addon}.sha256`, 'utf8').trim()
const manifest = JSON.parse(readFileSync(join(resolve(addon, '..'), 'singz-capture.manifest.json'), 'utf8'))
const originalAddon = readFileSync(addon)

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function signAddon(identifier) {
  run('/usr/bin/codesign', ['--remove-signature', addon])
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', identifier, addon])
  // Seal the outer app without signing the child a second time.
  run('/usr/bin/codesign', ['--force', '--sign', '-', appPath])
  run('/usr/bin/codesign', ['--verify', '--strict', addon])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
}

try {
  assert.equal(
    machCanonicalSha256(addon),
    manifest.machCanonicalSha256,
    'packaged canonical digest was sealed in the manifest'
  )
  // Reproduce a Developer-ID-style signature-only byte transformation.
  signAddon('com.lexasoft.singz.capture.package-test')
  const actualSha = createHash('sha256').update(readFileSync(addon)).digest('hex')
  assert.notEqual(actualSha, expectedSha, 'signing transformed the packaged Mach-O bytes')
  assert.equal(
    machCanonicalSha256(addon),
    manifest.machCanonicalSha256,
    'signature-only rewrite preserved the canonical digest'
  )
  run(require('electron'), [
    join(root, 'tests/e2e/capture-addon-smoke.cjs'), addon, '--signed-packaged-mac'
  ])

  // Change compiled identity bytes outside the signature, then produce a
  // perfectly consistent new signature. Canonical evidence must reject it
  // before require() can execute arbitrary re-signed code.
  run('/usr/bin/codesign', ['--remove-signature', addon])
  const tampered = readFileSync(addon)
  const needle = Buffer.from(manifest.sourceStamp, 'ascii')
  const at = tampered.indexOf(needle)
  assert.ok(at >= 0, 'compiled source stamp exists in the Mach-O')
  tampered[at] = tampered[at] === 0x30 ? 0x31 : 0x30
  writeFileSync(addon, tampered)
  run('/usr/bin/codesign', [
    '--force', '--sign', '-', '--identifier', 'com.lexasoft.singz.capture.tampered-test', addon
  ])
  run('/usr/bin/codesign', ['--force', '--sign', '-', appPath])
  run('/usr/bin/codesign', ['--verify', '--strict', addon])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  assert.notEqual(
    machCanonicalSha256(addon),
    manifest.machCanonicalSha256,
    'compiled-byte tamper changed canonical evidence'
  )
  const rejected = spawnSync(require('electron'), [
    join(root, 'tests/e2e/capture-addon-smoke.cjs'), addon, '--signed-packaged-mac'
  ], { cwd: root, encoding: 'utf8' })
  assert.notEqual(rejected.status, 0, 're-signed compiled-byte tamper was rejected')
  assert.match(
    `${rejected.stdout}\n${rejected.stderr}`,
    /canonical Mach-O digest mismatch/,
    'tamper failed at canonical verification before require'
  )
  console.log('PASS signed packaged capture addon; re-signed code tamper rejected')
} finally {
  writeFileSync(addon, originalAddon)
  run('/usr/bin/codesign', ['--force', '--sign', '-', appPath])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
}
