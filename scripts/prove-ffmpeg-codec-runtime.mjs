#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { canonicalFixtureNames } from './codec-target-proof-contract.mjs'
import {
  assertHostProofFixtureSet,
  hostExpectedOutput,
  hostProofBuildStamp,
  hostProofContract,
  loadHostProofSourceEvidence,
} from './codec-host-proof-contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const valueAfter = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length)
    throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}
const target = valueAfter('--target')
const stage = resolve(valueAfter('--stage'))
const testBinary = resolve(valueAfter('--test'))
const fixtures = resolve(valueAfter('--fixtures'))
const output = resolve(valueAfter('--output'))
const profile = JSON.parse(
  readFileSync(join(root, 'third_party', 'ffmpeg-codec', 'profile.json'), 'utf8'),
)

const hostTarget = process.platform === 'darwin'
  ? `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  : process.platform === 'win32' && process.arch === 'x64'
    ? 'win32-x64'
    : null
if (target !== hostTarget) {
  throw new Error(
    `Fixture proof must execute the target bytes; ${target} cannot run on ${process.platform}-${process.arch}`,
  )
}
if (!existsSync(testBinary) || !statSync(testBinary).isFile())
  throw new Error(`Missing codec fixture test binary: ${testBinary}`)

const source = loadHostProofSourceEvidence(root)
const fixtureNames = canonicalFixtureNames
assertHostProofFixtureSet({ fixtureDirectory: fixtures, source })

const environment = { ...process.env }
if (process.platform === 'darwin') {
  environment.DYLD_LIBRARY_PATH = [join(stage, 'lib'), environment.DYLD_LIBRARY_PATH]
    .filter(Boolean).join(':')
} else if (process.platform === 'win32') {
  environment.PATH = [join(stage, 'bin'), environment.PATH].filter(Boolean).join(';')
}
const run = spawnSync(testBinary, fixtureNames.map((name) => join(fixtures, name)), {
  env: environment,
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
})
if (run.error) throw run.error
const expectedOutput = hostExpectedOutput(profile)
if (run.status !== 0 || run.stdout !== expectedOutput) {
  process.stderr.write(run.stdout || '')
  process.stderr.write(run.stderr || '')
  throw new Error(`Codec fixture proof failed for ${target} (exit ${run.status})`)
}
// Bind the bytes both immediately before and after execution. A proof must
// never name the committed corpus while having exercised regenerated or
// concurrently replaced fixtures.
const executedFixtures = assertHostProofFixtureSet({ fixtureDirectory: fixtures, source })

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const major = profile.abiMajors
const candidates = {
  avcodec: target.startsWith('win32-')
    ? [`bin/avcodec-${major.avcodec}.dll`]
    : [`lib/libavcodec.${major.avcodec}.dylib`, 'lib/libavcodec.dylib'],
  avformat: target.startsWith('win32-')
    ? [`bin/avformat-${major.avformat}.dll`]
    : [`lib/libavformat.${major.avformat}.dylib`, 'lib/libavformat.dylib'],
  avutil: target.startsWith('win32-')
    ? [`bin/avutil-${major.avutil}.dll`]
    : [`lib/libavutil.${major.avutil}.dylib`, 'lib/libavutil.dylib'],
  swresample: target.startsWith('win32-')
    ? [`bin/swresample-${major.swresample}.dll`]
    : [`lib/libswresample.${major.swresample}.dylib`, 'lib/libswresample.dylib'],
}
const runtimeLibraries = {}
for (const [component, paths] of Object.entries(candidates)) {
  const relative = paths.find((candidate) => existsSync(join(stage, candidate)))
  if (!relative) throw new Error(`Staging tree has no ${component} runtime`)
  runtimeLibraries[component] = {
    path: relative,
    bytes: statSync(join(stage, relative)).size,
    sha256: sha256(join(stage, relative)),
  }
}

const configurationPath = join(stage, 'share', 'singz-ffmpeg', 'configuration.txt')
if (!existsSync(configurationPath)) throw new Error('Staging tree has no configure receipt')
const configurationSha256 = createHash('sha256')
  .update(readFileSync(configurationPath, 'utf8').trim()).digest('hex')
const buildConfigurationPath = [dirname(testBinary), dirname(dirname(testBinary))]
  .map((directory) => join(directory, 'CMakeCache.txt'))
  .find((path) => existsSync(path))
if (!buildConfigurationPath)
  throw new Error(`Codec proof binary has no adjacent CMake build configuration: ${testBinary}`)
const testBinarySha256 = sha256(testBinary)
const buildConfigurationSha256 = sha256(buildConfigurationPath)
const receipt = {
  format: 2,
  proofContract: hostProofContract,
  profile: profile.profile,
  target,
  capabilityMask: profile.capabilityMask,
  result: 'full dynamic matrix ok',
  proofSourceStamp: source.sourceStamp,
  fixtureGeneratorSha256: source.fixtureGeneratorSha256,
  testSourceSha256: source.sourceHashes,
  configurationSha256,
  testBinarySha256,
  buildConfigurationSha256,
  proofBuildStamp: hostProofBuildStamp({
    sourceStamp: source.sourceStamp,
    testBinarySha256,
    buildConfigurationSha256,
  }),
  runtimeLibraries,
  fixtures: executedFixtures,
  expectedOutputSha256: createHash('sha256').update(expectedOutput).digest('hex'),
  outputSha256: createHash('sha256').update(run.stdout).digest('hex'),
  diagnosticOutputSha256: createHash('sha256').update(run.stderr).digest('hex'),
}
writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`)
process.stdout.write(run.stdout)
process.stderr.write(run.stderr)
console.log(`Codec fixture receipt: ${output}`)
