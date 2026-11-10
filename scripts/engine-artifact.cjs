#!/usr/bin/env node
// Receipts describe reusable third-party executables, not mutable build trees.
const { createHash, randomBytes } = require('node:crypto')
const { copyFileSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const engines = {
  llama: { binary: 'llama-server', producer: 'vendor-llama.sh' },
  crispasr: { binary: 'crispasr', producer: 'vendor-crispasr.sh' },
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function assertBuildTarget(target, host = `${process.platform}-${process.arch}`) {
  if (!/^(darwin|win32|linux)-(arm64|x64)$/.test(target))
    throw new Error(`Unsupported engine target: ${target}`)
  if (target === host || (host.startsWith('darwin-') && target.startsWith('darwin-'))) return
  throw new Error(`Cannot build ${target} from ${host}; only native builds and Darwin arm64/x64 cross-builds are supported`)
}

function artifactPaths(root, engine, target) {
  if (!engines[engine]) throw new Error(`Unknown engine: ${engine}`)
  if (!/^(darwin|win32|linux)-(arm64|x64)$/.test(target))
    throw new Error(`Unsupported engine target: ${target}`)
  const name = engines[engine].binary + (target.startsWith('win32-') ? '.exe' : '')
  const binary = join(resolve(root), 'vendor', target, name)
  return { binary, receipt: `${binary}.receipt.json`, name }
}

function producerHash(root, engine) {
  const files = [engines[engine].producer, 'engine-artifact.cjs', 'assert-portable-binary.sh']
  const hash = createHash('sha256')
  for (const name of files) {
    hash.update(name).update('\0').update(readFileSync(join(root, 'scripts', name))).update('\0')
  }
  return hash.digest('hex')
}

function checkArtifact(root, engine, target, ref, producerRoot = root) {
  try {
    const paths = artifactPaths(root, engine, target)
    const receipt = JSON.parse(readFileSync(paths.receipt, 'utf8'))
    return receipt.format === 1 && receipt.engine === engine &&
      receipt.target === target && receipt.requestedRef === ref &&
      /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(receipt.sourceCommit) &&
      (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(ref) || receipt.sourceCommit === ref) &&
      receipt.producerHash === producerHash(producerRoot, engine) &&
      receipt.binarySha256 === sha256(readFileSync(paths.binary))
  } catch {
    return false
  }
}

function removeLink(path) {
  try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

// A branch may still have old whole-directory links. Detach those, then only
// the output links; never traverse a sibling's vendor directory while writing.
function prepareOutput(root, target, name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(target) || !/^[a-zA-Z0-9_.-]+$/.test(name))
    throw new Error('Invalid output target or name')
  const vendor = join(resolve(root), 'vendor')
  removeLink(vendor)
  mkdirSync(vendor, { recursive: true })
  const directory = join(vendor, target)
  removeLink(directory)
  mkdirSync(directory, { recursive: true })
  const output = join(directory, name)
  removeLink(output)
  removeLink(`${output}.receipt.json`)
  removeLink(`${output}.source-hash`)
  return output
}

function atomicCopy(source, output) {
  const temporary = `${output}.partial-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    copyFileSync(source, temporary)
    renameSync(temporary, output)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function stampArtifact(root, engine, target, ref, commit, expectedProducerHash = producerHash(root, engine)) {
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(commit)) throw new Error('Invalid source commit')
  if (/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(ref) && commit !== ref)
    throw new Error('Resolved source commit differs from requested commit')
  if (producerHash(root, engine) !== expectedProducerHash)
    throw new Error('Engine producer inputs changed during the build')
  const { binary, receipt } = artifactPaths(root, engine, target)
  // Stamping through a symlink could bless or replace another worktree's receipt.
  for (const path of [join(resolve(root), 'vendor'), join(resolve(root), 'vendor', target), binary, receipt]) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing shared output: ${path}`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const record = {
    format: 1, engine, target, requestedRef: ref, sourceCommit: commit,
    producerHash: expectedProducerHash, binarySha256: sha256(readFileSync(binary)),
  }
  const temporary = `${receipt}.partial-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    renameSync(temporary, receipt)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return record
}

module.exports = { assertBuildTarget, artifactPaths, checkArtifact, producerHash, prepareOutput, atomicCopy, stampArtifact }

if (require.main === module) {
  try {
    const [command, root, engine, target, ref, commitOrProducer, source, expectedProducerHash] = process.argv.slice(2)
    if (command === 'assert-build-target') assertBuildTarget(root)
    else if (command === 'check') process.exitCode = checkArtifact(root, engine, target, ref, commitOrProducer) ? 0 : 1
    else if (command === 'stamp') stampArtifact(root, engine, target, ref, commitOrProducer)
    else if (command === 'publish') {
      const { name } = artifactPaths(root, engine, target)
      if (expectedProducerHash && producerHash(root, engine) !== expectedProducerHash)
        throw new Error('Engine producer inputs changed during the build')
      atomicCopy(source, prepareOutput(root, target, name))
      stampArtifact(root, engine, target, ref, commitOrProducer, expectedProducerHash)
    } else if (command === 'producer-hash') {
      console.log(producerHash(root, engine))
    } else if (command === 'publish-file') {
      // publish-file <root> <target> <name> <source>
      atomicCopy(ref, prepareOutput(root, engine, target))
    } else throw new Error('Usage: engine-artifact.cjs check|stamp|publish <root> <engine> <target> <ref> [commit|producer-root] [source]')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
