#!/usr/bin/env node
// Idempotently add lines to a git exclude file shared by every worktree of a
// repository. Several `worktree-setup.sh` runs may update it at once, so the
// read-modify-write is serialized with a mkdir mutex and published with a
// temp-file rename (git never sees a half-written file, and no run's lines
// are lost to another's overwrite).
//
//   node scripts/ensure-git-exclude.cjs <exclude-file> <line>...
const { randomBytes } = require('node:crypto')
const {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync
} = require('node:fs')
const { dirname } = require('node:path')

const MUTEX_STALE_MS = 30_000
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function withMutex(path, body) {
  const mutex = `${path}.lock`
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      mkdirSync(mutex)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(mutex).mtimeMs > MUTEX_STALE_MS)
          rmSync(mutex, { recursive: true, force: true })
      } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${mutex}`)
      sleep(10 + Math.floor(Math.random() * 20))
    }
  }
  try { return body() } finally { rmSync(mutex, { recursive: true, force: true }) }
}

/** Append whichever of `lines` are missing (exact whole-line match); returns
 *  the lines added. Existing content is preserved byte for byte. */
function ensureExcludeLines(path, lines) {
  mkdirSync(dirname(path), { recursive: true })
  return withMutex(path, () => {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const present = new Set(current.split(/\r?\n/))
    const missing = []
    for (const line of lines) {
      if (!present.has(line) && !missing.includes(line)) missing.push(line)
    }
    if (!missing.length) return []
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    writeFileSync(temp, `${current}${separator}${missing.join('\n')}\n`)
    renameSync(temp, path)
    return missing
  })
}

module.exports = { ensureExcludeLines }

if (require.main === module) {
  const [path, ...lines] = process.argv.slice(2)
  if (!path || !lines.length) {
    console.error('Usage: ensure-git-exclude.cjs <exclude-file> <line>...')
    process.exit(2)
  }
  const added = ensureExcludeLines(path, lines)
  if (added.length) console.log(`Registered in ${path}: ${added.join(' ')}`)
}
