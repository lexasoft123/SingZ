#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const valueAfter = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length)
    throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}
const serial = valueAfter('--serial')
const target = valueAfter('--target')
const output = resolve(valueAfter('--output'))
const packageName = process.argv.includes('--package')
  ? valueAfter('--package')
  : 'com.lexasoft.singz'
if (!/^android-(?:arm64-v8a|armeabi-v7a|x86|x86_64)$/.test(target))
  throw new Error(`Unsupported Android proof target: ${target}`)
if (!/^[A-Za-z0-9._:-]+$/.test(packageName))
  throw new Error(`Unsafe Android package name: ${packageName}`)

const remote = `files/codec-target-proof/${target}.json`
const bytes = execFileSync('adb', [
  '-s', serial, 'exec-out', 'run-as', packageName, 'cat', remote,
], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
const evidence = JSON.parse(bytes)
if (evidence.format !== 1 || evidence.target !== target ||
    evidence.platform !== 'android' ||
    evidence.executionMode !== 'actual-packaged-runtime' ||
    evidence.result !== 'full dynamic matrix ok')
  throw new Error(`Pulled Android codec evidence is not a successful ${target} run`)
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`Android target codec evidence: ${output}`)
