#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTargetProofReceipt, validateTargetProofReceipt } from './codec-target-proof-contract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const valueAfter = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length)
    throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}
const target = valueAfter('--target')
const evidencePath = resolve(valueAfter('--evidence'))
const outputPath = resolve(valueAfter('--output'))
const pack = resolve(process.argv.includes('--pack')
  ? valueAfter('--pack')
  : join(root, 'vendor', 'ffmpeg-codec', target))
if (!existsSync(evidencePath)) throw new Error(`Missing target evidence: ${evidencePath}`)
const profile = JSON.parse(
  readFileSync(join(root, 'third_party', 'ffmpeg-codec', 'profile.json'), 'utf8'),
)
const receipt = createTargetProofReceipt({
  evidence: JSON.parse(readFileSync(evidencePath, 'utf8')),
  profile,
  target,
  pack,
  root,
})
validateTargetProofReceipt({ receipt, profile, target, pack, root })
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`Target codec proof receipt: ${outputPath}`)
