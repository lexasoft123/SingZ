#!/usr/bin/env node
/*
 * "Is node_modules what package-lock.json says it is?"
 *
 * `npm run build` and `npm run dev` bundle whatever sits in node_modules; they
 * never install. So a checkout that pulled a new lockfile without `npm ci`
 * builds the OLD dependencies without a word — and @singz/ui, a git tarball
 * that moves with most UI changes, is exactly the one that goes stale: a main
 * checkout built on 2026-09-24 still carried kit 1.7.0 three releases after
 * the lockfile had moved to 1.8.1, and shipped the very lane halo that 1.7.1
 * had taken out. The typecheck would have caught the drift; the build does not
 * typecheck.
 *
 * The answer is read from the files the bundler reads: every package the
 * lockfile names must be installed (optional ones — other platforms' binaries
 * — may be absent) with the version the lockfile records, per its own
 * package.json. npm's record of what it installed (the "hidden lockfile",
 * node_modules/.package-lock.json) adds the source and integrity, but only
 * where it agrees with those files about the version: a node_modules copied
 * from another tree and patched by hand keeps a record that describes neither
 * (the Windows field laptop's trees said kit 1.0.1 over kit 1.8.1 files).
 *
 * SINGZ_ALLOW_STALE_DEPS=1 downgrades the refusal to a warning, for the rare
 * deliberate case: a package put into node_modules by hand at a version the
 * lockfile does not name (a locally built kit, to try it before its tag).
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * What differs between the lockfile and what is installed, one line per
 * package; empty when node_modules is current.
 *
 * @param locked  package-lock.json's `packages`
 * @param files   key => the installed package.json at that key, or null
 * @param record  the hidden lockfile's `packages` ({} when there is none)
 */
function staleDeps(locked, files, record = {}) {
  const problems = []
  for (const [key, want] of Object.entries(locked)) {
    if (!key.startsWith('node_modules/') || want.link) continue // the root project, workspaces
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const have = files(key)
    if (!have) {
      if (!want.optional && !want.devOptional && !want.peer) problems.push(`${name} ${want.version}: not installed`)
      continue
    }
    if (want.version !== undefined && have.version !== undefined && have.version !== want.version) {
      problems.push(`${name}: installed ${have.version}, locked ${want.version}`)
      continue
    }
    const rec = record[key]
    if (!rec || rec.version !== have.version) continue // no record, or one that describes other files
    const differs = ['resolved', 'integrity'].filter((f) => want[f] !== undefined && rec[f] !== undefined && want[f] !== rec[f])
    if (differs.length) problems.push(`${name}: installed ${have.version} with a different ${differs.join(' and ')} than locked`)
  }
  return problems
}

module.exports = { staleDeps }

if (require.main === module) {
  const root = join(__dirname, '..')
  const refuse = (message) => {
    if (process.env.SINGZ_ALLOW_STALE_DEPS === '1') {
      console.warn(`installed deps (SINGZ_ALLOW_STALE_DEPS=1, building anyway): ${message}`)
      process.exit(0)
    }
    console.error(message)
    process.exit(1)
  }
  // npm's record and each package.json may be missing or odd, and each only
  // ever answers "cannot tell" for its own package; the lockfile is the
  // question itself, so one that will not parse (merge markers) is a refusal.
  const json = (p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      return null
    }
  }
  let locked
  try {
    locked = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages ?? {}
  } catch (e) {
    refuse(`package-lock.json is unreadable, so node_modules cannot be checked against it: ${e.message}`)
  }
  const record = json(join(root, 'node_modules', '.package-lock.json'))?.packages ?? {}
  const problems = staleDeps(locked, (key) => json(join(root, key, 'package.json')), record)
  if (problems.length === 0) process.exit(0)
  const shown = problems.slice(0, 8).map((p) => `  ${p}`)
  if (problems.length > shown.length) shown.push(`  …and ${problems.length - shown.length} more`)
  refuse(`node_modules does not match package-lock.json — run \`npm ci\`:\n${shown.join('\n')}`)
}
