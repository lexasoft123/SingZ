'use strict'
/**
 * A throwaway desktop profile for a driver that launches the app.
 *
 * The product's userData and Chromium sessionData are always <appData>/SingZ,
 * so an Electron launched without SINGZ_USERDATA_DIR lands in the singer's
 * real profile (settings, Drive tokens, the dirty ledger, voice takes) and
 * shares its session directory with a running app. Every driver that launches
 * the app puts `...scratchProfileEnv()` in its launch env instead, and a
 * source test (tests/unit/e2e-scratch-profile.test.ts) refuses one that does
 * not.
 *
 *   env: { ...process.env, ...scratchProfileEnv({ projectsRoot: ROOT }), ... }
 *
 * `projectsRoot` seeds settings.json for a driver that opens songs from a
 * library other than the default one. Pass `dir` to reuse a directory the
 * driver made itself. The directory is removed when the driver exits.
 */
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const made = []
process.on('exit', () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort: a launched app may still hold it */
    }
  }
})

/** A fresh empty profile directory, removed on exit. */
function scratchProfileDir(label = 'driver') {
  const dir = mkdtempSync(join(tmpdir(), `singz-profile-${label}-`))
  made.push(dir)
  return dir
}

/** {SINGZ_USERDATA_DIR} for a fresh profile (or `dir`), optionally seeded with settings. */
function scratchProfileEnv({ label, dir, projectsRoot, settings } = {}) {
  const profile = dir ?? scratchProfileDir(label)
  mkdirSync(profile, { recursive: true })
  const seeded = { ...(projectsRoot ? { projectsRoot } : {}), ...settings }
  if (Object.keys(seeded).length) writeFileSync(join(profile, 'settings.json'), JSON.stringify(seeded, null, 2))
  return { SINGZ_USERDATA_DIR: profile }
}

module.exports = { scratchProfileDir, scratchProfileEnv }
