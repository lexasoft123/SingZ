import { readdir, readFile, stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDisjointLocalClosures } from './renderer-split-graph.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = resolve(projectRoot, 'out/renderer')
const assetsRoot = resolve(rendererRoot, 'assets')
const indexHtml = await readFile(resolve(rendererRoot, 'index.html'), 'utf8')
const entryMatch = indexHtml.match(/<script[^>]+src="\.\/assets\/([^"/]+\.js)"/)
if (!entryMatch) throw new Error('Renderer split check: initial renderer script was not found.')

const files = await readdir(assetsRoot)
const trainingChunks = files.filter((file) => /^VocalTraining-[\w-]+\.js$/.test(file))
if (trainingChunks.length !== 2) {
  throw new Error(`Renderer split check: expected primary/recovery VocalTraining chunks, found ${trainingChunks.length}.`)
}
const dropScreenChunks = files.filter((file) => /^DropScreen-[\w-]+\.js$/.test(file))
if (dropScreenChunks.length !== 2) {
  throw new Error(`Renderer split check: expected primary/recovery DropScreen chunks, found ${dropScreenChunks.length}.`)
}

const recoverableDialogs = ['LibraryImport', 'LogPanel', 'ProjectPicker', 'SetupModal']
const dialogChunks = new Map(recoverableDialogs.map((name) => [
  name,
  files.filter((file) => new RegExp(`^${name}-[\\w-]+\\.js$`).test(file))
]))
for (const [name, chunks] of dialogChunks) {
  if (chunks.length !== 2) {
    throw new Error(
      `Renderer split check: expected distinct primary/recovery chunks for ${name}, found ${chunks.length}.`
    )
  }
}
const wizardChunks = files.filter((file) => /^SetupWizard-[\w-]+\.js$/.test(file))
if (wizardChunks.length !== 0) {
  throw new Error('Renderer split check: SetupWizard must stay eager to preserve download ownership.')
}
const signalsmithChunks = files.filter((file) => /^SignalsmithStretch-[\w-]+\.js$/.test(file))
if (signalsmithChunks.length !== 0) {
  throw new Error('Renderer split check: Signalsmith must stay eager for synchronous song DSP.')
}
const settingsChunks = files.filter((file) => /^SettingsModal-[\w-]+\.js$/.test(file))
if (settingsChunks.length !== 1) {
  throw new Error(`Renderer split check: expected one terminal Settings chunk, found ${settingsChunks.length}.`)
}
const trackChunks = files.filter((file) => /^TrackStack-[\w-]+\.js$/.test(file))
if (trackChunks.length !== 0) {
  throw new Error('Renderer split check: TrackStack must stay eager with the song engine and transport.')
}

const entryFile = entryMatch[1]
const entrySource = await readFile(resolve(assetsRoot, entryFile), 'utf8')
for (const [name, chunks] of [
  ...dialogChunks,
  ['DropScreen', dropScreenChunks],
  ['VocalTraining', trainingChunks],
  ['SettingsModal', settingsChunks]
]) {
  for (const chunk of chunks) {
    if (!entrySource.includes(`./${chunk}`)) {
      throw new Error(`Renderer split check: entry does not reference ${name} route chunk ${chunk}.`)
    }
  }
}

const sourceCache = new Map([[entryFile, entrySource]])
async function chunkSource(file) {
  const cached = sourceCache.get(file)
  if (cached !== undefined) return cached
  const source = await readFile(resolve(assetsRoot, file), 'utf8')
  sourceCache.set(file, source)
  return source
}

for (const [name, chunks] of [
  ...dialogChunks,
  ['DropScreen', dropScreenChunks],
  ['VocalTraining', trainingChunks]
]) {
  await assertDisjointLocalClosures({
    name,
    roots: chunks,
    entryFile,
    files,
    readSource: chunkSource
  })
}
for (const chunk of [
  ...[...dialogChunks.values()].flatMap((chunks) => chunks),
  ...dropScreenChunks,
  ...trainingChunks,
  ...settingsChunks
]) {
  if (indexHtml.includes(chunk)) {
    throw new Error(`Renderer split check: on-demand chunk ${chunk} is preloaded by index.html.`)
  }
}

const ENTRY_RAW_BUDGET = 1_275_000
const TRAINING_RAW_BUDGET = 80_000
const entryBytes = (await stat(resolve(assetsRoot, entryFile))).size
const trainingBytes = await Promise.all(trainingChunks.map(async (file) =>
  (await stat(resolve(assetsRoot, file))).size
))
if (entryBytes > ENTRY_RAW_BUDGET) {
  throw new Error(`Renderer split check: entry is ${entryBytes} B (budget ${ENTRY_RAW_BUDGET} B).`)
}
if (trainingBytes.some((bytes) => bytes > TRAINING_RAW_BUDGET)) {
  throw new Error(`Renderer split check: VocalTraining chunks are ${trainingBytes.join('/')} B (budget ${TRAINING_RAW_BUDGET} B each).`)
}

const entryGzip = gzipSync(await readFile(resolve(assetsRoot, entryFile))).byteLength
console.log(
  `renderer split: entry ${entryBytes} B raw / ${entryGzip} B gzip; ` +
  `VocalTraining ${trainingBytes.join('/')} B raw`
)
