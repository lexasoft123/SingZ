#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const sourceRoot = join(repo, 'tests', 'fixtures', 'codecs')
const targetRoot = join(repo, 'mobile', 'ios', 'FolderAccess', 'CodecTargetProof')
const fixtureNames = [
  'tone.mp3',
  'tone.aac',
  'tone-aac.m4a',
  'tone-alac.m4a',
  'tone.ogg',
  'tone.opus',
  'tone.aiff',
  'tone.aifc',
  'audio-plus-video.m4a',
  'video-only.m4a',
  'unsupported-flac.ogg',
  'cancel-long.mp3',
]
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

for (const path of [
  join(sourceRoot, 'target', 'target_codec_proof.cpp'),
  join(sourceRoot, 'target', 'target_codec_proof.h'),
  ...fixtureNames.map((name) => join(sourceRoot, 'data', name)),
  join(sourceRoot, 'generate.sh'),
  join(sourceRoot, 'target-contract.json'),
]) {
  if (!existsSync(path) || !statSync(path).isFile())
    throw new Error(`Missing canonical codec target proof input: ${path}`)
}

rmSync(targetRoot, { recursive: true, force: true })
mkdirSync(join(targetRoot, 'fixtures'), { recursive: true })
for (const name of ['target_codec_proof.cpp', 'target_codec_proof.h'])
  copyFileSync(join(sourceRoot, 'target', name), join(targetRoot, name))
for (const name of fixtureNames)
  copyFileSync(join(sourceRoot, 'data', name), join(targetRoot, 'fixtures', name))

const rows = [
  ...['target_codec_proof.cpp', 'target_codec_proof.h'].map((name) => ({
    path: name,
    source: `tests/fixtures/codecs/target/${name}`,
  })),
  ...fixtureNames.map((name) => ({
    path: `fixtures/${name}`,
    source: `tests/fixtures/codecs/data/${name}`,
  })),
].map((row) => ({
  ...row,
  bytes: statSync(join(targetRoot, row.path)).size,
  sha256: sha256(join(targetRoot, row.path)),
}))
const sourceHashes = {
  cpp: sha256(join(sourceRoot, 'target', 'target_codec_proof.cpp')),
  header: sha256(join(sourceRoot, 'target', 'target_codec_proof.h')),
  generator: sha256(join(sourceRoot, 'generate.sh')),
  contract: sha256(join(sourceRoot, 'target-contract.json')),
}
const sourceStamp = createHash('sha256').update(
  `${sourceHashes.cpp}:${sourceHashes.header}:${sourceHashes.generator}:${sourceHashes.contract}`,
).digest('hex')
const platformPaths = {
  bridgeHeader: join(repo, 'mobile', 'ios', 'FolderAccess', 'NativeCodecTargetProof.h'),
  bridge: join(repo, 'mobile', 'ios', 'FolderAccess', 'NativeCodecTargetProof.mm'),
  runtimeModule: join(repo, 'mobile', 'ios', 'FolderAccess', 'NativeAudioRuntimeBridge.mm'),
  appHook: join(repo, 'mobile', 'App.tsx'),
  prepare: join(repo, 'mobile', 'scripts', 'prepare-codec-target-proof.mjs'),
  driver: join(repo, 'mobile', 'tests', 'codec-target-ios.cjs'),
}
const platformSourceHashes = Object.fromEntries(
  Object.entries(platformPaths).map(([name, path]) => [name, sha256(path)]),
)
const platformSourceStamp = createHash('sha256').update(
  Object.keys(platformSourceHashes).sort()
    .map((name) => `${name}:${platformSourceHashes[name]}`).join(':'),
).digest('hex')
const buildStamp = createHash('sha256')
  .update(`${sourceStamp}:${platformSourceStamp}`).digest('hex')
writeFileSync(join(targetRoot, 'materialization.json'), `${JSON.stringify({
  format: 1,
  sourceStamp,
  sourceHashes,
  platformSourceStamp,
  platformSourceHashes,
  buildStamp,
  files: rows,
}, null, 2)}\n`)
console.log(`Prepared iOS codec target proof: ${rows.length} canonical files`)
