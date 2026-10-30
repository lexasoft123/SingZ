#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

function resolveLibraryOutput(compileDir, abi) {
  if (!compileDir || !abi) throw new Error('usage: android-native-library-output.cjs <compile-dir> <abi>')
  const cachePath = path.join(compileDir, 'CMakeCache.txt')
  const cache = fs.readFileSync(cachePath, 'utf8')
  const entries = cache.split(/\r?\n/)
    .map(line => line.match(/^CMAKE_LIBRARY_OUTPUT_DIRECTORY(?::[^=]+)?=(.*)$/))
    .filter(Boolean)
  if (entries.length !== 1 || !entries[0][1].trim()) {
    throw new Error(`expected one nonempty CMAKE_LIBRARY_OUTPUT_DIRECTORY in ${cachePath}`)
  }

  const outputDir = entries[0][1].trim()
  const resolvedDir = path.isAbsolute(outputDir) ? outputDir : path.resolve(compileDir, outputDir)
  if (path.basename(resolvedDir) !== abi) {
    throw new Error(`CMAKE_LIBRARY_OUTPUT_DIRECTORY for ${abi} resolves to unexpected directory: ${resolvedDir}`)
  }
  const library = path.join(resolvedDir, 'libsingzcore.so')
  if (!fs.statSync(library, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`libsingzcore.so is missing from configured output directory: ${library}`)
  }
  return library
}

if (require.main === module) {
  try {
    process.stdout.write(resolveLibraryOutput(process.argv[2], process.argv[3]) + '\n')
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = { resolveLibraryOutput }
