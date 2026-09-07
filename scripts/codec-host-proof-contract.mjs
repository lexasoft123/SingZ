import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { canonicalFixtureNames } from './codec-target-proof-contract.mjs'

export const hostProofContract = 'singz-codec-host-proof-v2'
export const hostExpectedOutput = (profile) =>
  `codec runtime: tag=singz-prepared-audio-fd-ffmpeg-full-matrix-v3 ` +
  `mask=${profile.capabilityMask} version=${profile.source.version} dynamic=yes\n` +
  'codec provisioning tests: full dynamic matrix ok\n'
const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const sha256File = (path) => sha256Bytes(readFileSync(path))
const sha256Text = (text) => sha256Bytes(Buffer.from(text, 'utf8'))
const isSha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const exact = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label} does not match the host codec proof contract`)
}
const requireFile = (path, label) => {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing ${label}: ${path}`)
  return path
}

export const loadHostProofSourceEvidence = (root) => {
  const absolute = resolve(root)
  const paths = {
    test: join(absolute, 'tests', 'native', 'codec_provisioning_tests.cpp'),
    decoder: join(absolute, 'zcore', 'src', 'media', 'ffmpeg_decoder.cpp'),
    decoderInternal: join(absolute, 'zcore', 'src', 'media', 'decoded_audio_internal.h'),
    decoderPublic: join(absolute, 'zcore', 'include', 'zcore', 'media', 'decoded_audio.h'),
    generator: join(absolute, 'tests', 'fixtures', 'codecs', 'generate.sh'),
    contract: join(absolute, 'tests', 'fixtures', 'codecs', 'target-contract.json'),
    prover: join(absolute, 'scripts', 'prove-ffmpeg-codec-runtime.mjs'),
    hostContract: join(absolute, 'scripts', 'codec-host-proof-contract.mjs'),
    buildDriver: join(absolute, 'scripts', 'build-ffmpeg-codec-runtime.sh'),
    rootCmake: join(absolute, 'CMakeLists.txt'),
    zcoreCmake: join(absolute, 'zcore', 'CMakeLists.txt'),
  }
  const sourceHashes = Object.fromEntries(Object.entries(paths).map(([name, path]) => [
    name, sha256File(requireFile(path, `host codec proof source ${name}`)),
  ]))
  const sourceStamp = sha256Text(
    Object.keys(sourceHashes).sort().map((name) => `${name}:${sourceHashes[name]}`).join(':'),
  )
  const contract = JSON.parse(readFileSync(paths.contract, 'utf8'))
  exact(contract.fixtures?.map((row) => row.name), canonicalFixtureNames, 'fixture name/order')
  const fixtures = canonicalFixtureNames.map((name) => {
    const path = requireFile(join(absolute, 'tests', 'fixtures', 'codecs', 'data', name),
      `canonical codec fixture ${name}`)
    const row = { name, bytes: statSync(path).size, sha256: sha256File(path) }
    exact(row, contract.fixtures.find((expected) => expected.name === name), `fixture ${name}`)
    return row
  })
  return {
    sourceHashes,
    sourceStamp,
    fixtureGeneratorSha256: sourceHashes.generator,
    fixtures,
  }
}

export const assertHostProofFixtureSet = ({ fixtureDirectory, source }) => {
  const directory = resolve(fixtureDirectory)
  const actualNames = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  exact(actualNames, [...canonicalFixtureNames].sort(), 'executed fixture name set')
  const actual = canonicalFixtureNames.map((name) => {
    const path = requireFile(join(directory, name), `executed codec fixture ${name}`)
    return { name, bytes: statSync(path).size, sha256: sha256File(path) }
  })
  exact(actual, source.fixtures, 'executed fixture bytes/order')
  return actual
}

export const validateHostProofReceipt = ({
  receipt,
  root,
  profile,
  target,
  configurationSha256,
  runtimeLibraries,
}) => {
  const source = loadHostProofSourceEvidence(root)
  const expectedOutputSha256 = sha256Text(hostExpectedOutput(profile))
  if (receipt?.format !== 2 || receipt.proofContract !== hostProofContract ||
      receipt.profile !== profile.profile || receipt.target !== target ||
      receipt.capabilityMask !== profile.capabilityMask ||
      receipt.result !== 'full dynamic matrix ok' ||
      receipt.proofSourceStamp !== source.sourceStamp ||
      receipt.fixtureGeneratorSha256 !== source.fixtureGeneratorSha256 ||
      receipt.configurationSha256 !== configurationSha256 ||
      receipt.expectedOutputSha256 !== expectedOutputSha256 ||
      receipt.outputSha256 !== expectedOutputSha256)
    throw new Error('Host codec receipt does not bind this profile/source/output/configuration')
  exact(receipt.testSourceSha256, source.sourceHashes, 'host proof source hashes')
  exact(receipt.fixtures, source.fixtures, 'host proof fixture bytes/order')
  if (!isSha(receipt.testBinarySha256) || !isSha(receipt.buildConfigurationSha256) ||
      !isSha(receipt.diagnosticOutputSha256) ||
      receipt.proofBuildStamp !== sha256Text(
        `${source.sourceStamp}:${receipt.testBinarySha256}:${receipt.buildConfigurationSha256}`,
      ))
    throw new Error('Host codec receipt has no exact proof binary/build stamp')
  const expectedComponents = ['avcodec', 'avformat', 'avutil', 'swresample']
  exact(Object.keys(receipt.runtimeLibraries ?? {}).sort(), [...expectedComponents].sort(),
    'host runtime component set')
  for (const component of expectedComponents) {
    const actual = receipt.runtimeLibraries[component]
    const expected = runtimeLibraries[component]
    if (actual?.path !== expected?.path || actual?.bytes !== expected?.bytes ||
        actual?.sha256 !== expected?.sha256)
      throw new Error(`Host codec receipt does not bind ${component}`)
  }
  return receipt
}

export const hostProofBuildStamp = ({ sourceStamp, testBinarySha256, buildConfigurationSha256 }) =>
  sha256Text(`${sourceStamp}:${testBinarySha256}:${buildConfigurationSha256}`)
