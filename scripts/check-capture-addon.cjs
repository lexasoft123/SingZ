#!/usr/bin/env node
/*
 * Says whether the built capture addon belongs to this checkout — at BUILD
 * time, where you can act on it, instead of inside the running app.
 *
 * `npm run build` bundles JS and nothing else; the addon is its own target
 * (`npm run capture:addon -- <target>`), and it is content-addressed: it
 * carries the fingerprint of the native sources it was compiled from, and the
 * app refuses one whose fingerprint is not the tree's. That refusal is the
 * guard working — an addon from another checkout is the "stale binary reports
 * green" trap, and native playback and native capture BOTH live in it, so the
 * app quietly falls back to Web Audio and says so only in a red line in
 * Settings. Learning that from the app is learning it in the wrong place.
 *
 * Deliberately a WARNING, not a failure. A renderer-only change must still
 * build on a machine with no compiler, or with a codec pack that has drifted,
 * and packaging (`npm run dist`) builds and validates the addon itself, so
 * nothing that ships depends on this. `--strict` turns it into an error for
 * anyone who wants that locally.
 */
const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const strict = process.argv.includes('--strict')
const target = `${process.platform}-${process.arch}`

const say = (line) => process.stdout.write(`capture addon: ${line}\n`)
const warn = (line) => process.stderr.write(`capture addon: ${line}\n`)

/** The fingerprint of the native sources as they stand now, or null if it
 *  cannot be taken. Never throws: this whole script is a warning, and a
 *  warning that can end the build with a stack trace is not one. (`--print-
 *  source-fingerprint` only prints — it returns before the codec pack, the
 *  build lock and every write — but it walks six source trees, and a tree
 *  missing one of them should not stop a renderer build.) */
function treeFingerprint() {
  try {
    return execFileSync(
      process.execPath,
      [join(root, 'scripts', 'build-capture-addon.cjs'), '--print-source-fingerprint'],
      { cwd: root, encoding: 'utf8' }
    ).trim()
  } catch (error) {
    warn(`could not fingerprint the native sources (${String(error).split('\n')[0]})`)
    return null
  }
}

/** What the built package for this host says it was compiled from, or null. */
function builtFingerprint() {
  const manifest = join(root, 'build', 'capture-package', target, 'singz-capture.manifest.json')
  if (!existsSync(manifest)) return null
  try {
    const value = JSON.parse(readFileSync(manifest, 'utf8'))
    return typeof value.sourceStamp === 'string' ? value.sourceStamp : null
  } catch {
    return null
  }
}

const built = builtFingerprint()
if (built === null) {
  // Not a problem in itself: build.yml's job builds no addon, and packaging
  // (and e2e-win) build their own before they get here.
  say(`none built for ${target} — run \`npm run capture:addon -- ${target}\` to`
    + ' use native playback or the microphone from this tree')
  process.exit(0)
}

const tree = treeFingerprint()
if (tree === null) process.exit(0)
if (built === tree) {
  say(`${target} matches this checkout (${tree.slice(0, 12)})`)
  process.exit(0)
}

warn(`the built ${target} addon is from a DIFFERENT checkout`)
warn(`  built ${built.slice(0, 12)} · tree ${tree.slice(0, 12)}`)
warn(`  the app will refuse it: native playback falls back to Web Audio and the`)
warn(`  microphone is unavailable. Rebuild: npm run capture:addon -- ${target}`)
process.exit(strict ? 1 : 0)
