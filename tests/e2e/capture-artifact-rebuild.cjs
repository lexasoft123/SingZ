const assert = require('node:assert/strict')
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  currentRuntimeArtifact,
  replacePathPreserving,
  runtimeArtifact,
  uniqueGeneration,
  validCaptureArtifact
} = require('../../scripts/capture-artifact.cjs')

const root = resolve(__dirname, '../..')
const target = process.argv[2] || `${process.platform}-${process.arch}`
const current = currentRuntimeArtifact(root, target)
const originalCurrent = readFileSync(current.manifestPath)
const valid = (addonPath, sourceStamp) => validCaptureArtifact({
  addon: addonPath,
  sourceHash: `${addonPath}.source-hash`,
  checksum: `${addonPath}.sha256`,
  expectedSourceStamp: sourceStamp
})

let repaired = false
const corruptManifest = { ...current.manifest, generation: uniqueGeneration() }
const corruptAddon = runtimeArtifact(
  root,
  target,
  corruptManifest.sourceStamp,
  corruptManifest.artifactSha256,
  corruptManifest.generation
)
const selectManifest = (contents) => {
  const partial = `${current.manifestPath}.test-part-${process.pid}`
  writeFileSync(partial, contents)
  replacePathPreserving(partial, current.manifestPath)
}
try {
  mkdirSync(dirname(corruptAddon), { recursive: true })
  writeFileSync(corruptAddon, Buffer.from('deliberately corrupt capture artifact'))
  writeFileSync(`${corruptAddon}.source-hash`, `${corruptManifest.sourceStamp}\n`)
  writeFileSync(`${corruptAddon}.sha256`, `${corruptManifest.artifactSha256}\n`)
  writeFileSync(
    join(dirname(corruptAddon), 'singz-capture.manifest.json'),
    `${JSON.stringify(corruptManifest, null, 2)}\n`
  )
  selectManifest(`${JSON.stringify(corruptManifest, null, 2)}\n`)
  assert.equal(valid(corruptAddon, corruptManifest.sourceStamp), false, 'corruption detected')
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts/build-capture-addon.cjs'), target],
    { cwd: root, stdio: 'inherit' }
  )
  assert.equal(result.status, 0, 'capture rebuild completed')
  const after = currentRuntimeArtifact(root, target)
  assert.equal(after.manifest.sourceStamp, current.manifest.sourceStamp, 'same source address')
  assert.notEqual(after.addonPath, corruptAddon, 'repair published a fresh generation')
  assert.notEqual(after.addonPath, current.addonPath, 'repair did not overwrite the prior generation')
  assert.ok(
    after.addonPath.includes(after.manifest.artifactSha256),
    'runtime path includes the artifact SHA address'
  )
  assert.equal(valid(after.addonPath, after.manifest.sourceStamp), true, 'artifact repaired')
  repaired = true
  console.log(`PASS corrupt capture artifact rebuilt: ${target}`)
} finally {
  rmSync(dirname(corruptAddon), { recursive: true, force: true })
  // Never leave current.json selecting the deliberately broken test
  // generation if the command under test fails.
  if (!repaired) {
    selectManifest(originalCurrent)
  }
}
