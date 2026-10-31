'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')

const checker = resolve(__dirname, '../../scripts/check-android-optimization.py')
const python = process.platform === 'win32' ? 'python' : 'python3'
const fixtureWriter = `
import json, sys, zipfile
fixture = json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1], 'w') as bundle:
    bundle.writestr('BUNDLE-METADATA/com.android.tools/r8.json', json.dumps(fixture['report']))
    bundle.writestr('BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map', fixture['mapping'])
    bundle.writestr('base/dex/classes.dex', fixture['dex'])
`

function checkFixture(t, modify = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'singz android optimization '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Configuration can promise optimized shrinking while the artifact still
  // contains the old pipeline. The checker must judge only the shipped AAB.
  writeFileSync(join(root, 'gradle.properties'), 'android.r8.optimizedResourceShrinking=true\n')
  const fixture = {
    report: {
      options: { isObfuscationEnabled: true, isOptimizationsEnabled: true, isShrinkingEnabled: true },
      resourceOptimization: { isOptimizedShrinkingEnabled: true },
      stats: { noObfuscationPercentage: 50, noOptimizationPercentage: 50, noShrinkingPercentage: 50 },
    },
    mapping: 'original.Class -> a:\n',
    dex: 'fixture DEX bytes',
  }
  modify(fixture)
  const bundle = join(root, 'release app.aab')
  const created = spawnSync(python, ['-c', fixtureWriter, bundle], {
    input: JSON.stringify(fixture), encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(created.status, 0, `${created.error || ''}${created.stdout}${created.stderr}`)
  return spawnSync(python, [checker, bundle], { cwd: root, encoding: 'utf8', timeout: 10_000 })
}

test('AAB optimization gate accepts optimized resource shrinking with code optimization evidence', t => {
  const result = checkFixture(t)
  assert.equal(result.status, 0, `${result.error || ''}${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /Resource shrinking: optimized \(verified in R8 metadata\)/)
  for (const category of ['Obfuscation', 'Optimization', 'Shrinking'])
    assert.ok(result.stdout.includes(`${category}: 50.00% eligible`))
  assert.match(result.stdout, /Total uncompressed DEX: \d+ bytes; mapping included/)
})

for (const [label, modify] of [
  ['disabled', f => { f.report.resourceOptimization.isOptimizedShrinkingEnabled = false }],
  ['missing flag', f => { delete f.report.resourceOptimization.isOptimizedShrinkingEnabled }],
  ['missing resource metadata', f => { delete f.report.resourceOptimization }],
  ['nonboolean flag', f => { f.report.resourceOptimization.isOptimizedShrinkingEnabled = 'true' }],
]) {
  test(`AAB optimization gate rejects ${label} despite enabled Gradle configuration`, t => {
    const result = checkFixture(t, modify)
    assert.equal(result.status, 1, `${result.error || ''}${result.stdout}${result.stderr}`)
    assert.match(result.stderr, /R8 optimized resource shrinking must be enabled/)
  })
}

for (const key of ['isObfuscationEnabled', 'isOptimizationsEnabled', 'isShrinkingEnabled']) {
  test(`AAB optimization gate still requires ${key}`, t => {
    const result = checkFixture(t, f => { f.report.options[key] = false })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(`R8 ${key} must be enabled`))
  })
}

for (const category of ['Obfuscation', 'Optimization', 'Shrinking']) {
  test(`AAB optimization gate still enforces the ${category} threshold`, t => {
    const result = checkFixture(t, f => { f.report.stats[`no${category}Percentage`] = 76 })
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(`${category} is below the 25% Play threshold`))
  })
}

test('AAB optimization gate still requires the mapping and DEX payload', t => {
  for (const [field, message] of [['mapping', /missing its obfuscation mapping/], ['dex', /contains no DEX code/]]) {
    const result = checkFixture(t, f => { f[field] = '' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
  }
})
