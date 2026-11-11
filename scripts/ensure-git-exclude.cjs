#!/usr/bin/env node
// Idempotently add lines to a git exclude file shared by every worktree of a
// repository. Several `worktree-setup.sh` runs may update it at once. There is
// no lock (a lock needs a staleness rule, and a wrong one lets two writers
// overlap) and no rewrite: a read-modify-write that publishes the whole file
// (temp + rename) loses any line another writer appended between its read and
// its rename, even after that writer already verified and exited. Writers
// therefore only APPEND their missing lines with one O_APPEND write, which can
// never discard anyone else's, then re-read and repeat until all of their own
// lines are present. Distinct lines are never lost or duplicated. Two writers
// adding the SAME line in the same instant can leave it twice; git treats
// repeated exclude lines as one, so that is left alone rather than rewritten.
//
//   node scripts/ensure-git-exclude.cjs <exclude-file> <line>...
const {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync
} = require('node:fs')
const { dirname } = require('node:path')

const MAX_ATTEMPTS = 50

function missingFrom(current, lines) {
  const present = new Set(current.split(/\r?\n/))
  const missing = []
  for (const line of lines) {
    if (!present.has(line) && !missing.includes(line)) missing.push(line)
  }
  return missing
}

/** Append whichever of `lines` are missing (exact whole-line match); returns
 *  the lines this call found missing. Existing content is preserved byte for byte. */
function ensureExcludeLines(path, lines) {
  mkdirSync(dirname(path), { recursive: true })
  let added = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; ++attempt) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const missing = missingFrom(current, lines)
    added ??= missing
    if (!missing.length) return added
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    const fd = openSync(path, 'a')
    try {
      writeSync(fd, `${separator}${missing.join('\n')}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // Loop: the re-read confirms our lines are in the file.
  }
  throw new Error(`Could not register ${lines.join(' ')} in ${path} after ${MAX_ATTEMPTS} attempts`)
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
