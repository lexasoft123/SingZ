import { readdir, readFile, stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererRoot = resolve(projectRoot, 'out/renderer')
const assetsRoot = resolve(rendererRoot, 'assets')
const indexHtml = await readFile(resolve(rendererRoot, 'index.html'), 'utf8')
const entryMatch = indexHtml.match(/<script[^>]+src="\.\/assets\/([^"/]+\.js)"/)
if (!entryMatch) throw new Error('Renderer split check: initial renderer script was not found.')

const files = await readdir(assetsRoot)
const trainingChunks = files.filter((file) => /^VocalTraining-[\w-]+\.js$/.test(file))
if (trainingChunks.length !== 1) {
  throw new Error(`Renderer split check: expected one VocalTraining chunk, found ${trainingChunks.length}.`)
}

const entryFile = entryMatch[1]
const trainingFile = trainingChunks[0]
const entrySource = await readFile(resolve(assetsRoot, entryFile), 'utf8')
if (!entrySource.includes(`./${trainingFile}`)) {
  throw new Error('Renderer split check: the entry does not dynamically reference VocalTraining.')
}
if (indexHtml.includes(trainingFile)) {
  throw new Error('Renderer split check: VocalTraining is preloaded by index.html.')
}

const ENTRY_RAW_BUDGET = 1_275_000
const TRAINING_RAW_BUDGET = 80_000
const entryBytes = (await stat(resolve(assetsRoot, entryFile))).size
const trainingBytes = (await stat(resolve(assetsRoot, trainingFile))).size
if (entryBytes > ENTRY_RAW_BUDGET) {
  throw new Error(`Renderer split check: entry is ${entryBytes} B (budget ${ENTRY_RAW_BUDGET} B).`)
}
if (trainingBytes > TRAINING_RAW_BUDGET) {
  throw new Error(`Renderer split check: VocalTraining is ${trainingBytes} B (budget ${TRAINING_RAW_BUDGET} B).`)
}

const entryGzip = gzipSync(await readFile(resolve(assetsRoot, entryFile))).byteLength
const trainingGzip = gzipSync(await readFile(resolve(assetsRoot, trainingFile))).byteLength
console.log(
  `renderer split: entry ${entryBytes} B raw / ${entryGzip} B gzip; ` +
  `VocalTraining ${trainingBytes} B raw / ${trainingGzip} B gzip`
)
