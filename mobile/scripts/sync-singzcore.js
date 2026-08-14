#!/usr/bin/env node
/**
 * Materialize the shared C++ engine core (mobile/native/core, one source tree
 * with Android) into the SingzCore pod as REAL files. CocoaPods silently
 * drops source_files globs that reach above the podspec dir, and its file
 * lists skip directory symlinks too (both measured: libSingzCore.a shipped
 * without ort_env.o and the app link died on singz::ortProbeJson) — copying
 * is the only shape that works, the same lesson as patch-audio-api.js.
 *
 * Runs from mobile's postinstall. After EDITING files in native/core, rerun
 * this + `pod install` (with a SingzCore.podspec version bump so the glob
 * re-evaluates) or Xcode keeps building the stale copy.
 */
const { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const src = join(root, 'native', 'core')
const dst = join(root, 'ios', 'SingzCore', 'core')

rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
let n = 0
for (const f of readdirSync(src)) {
  if (!/\.(h|hpp|cpp)$/.test(f)) continue // android/ subdir (JNI shim) stays out
  copyFileSync(join(src, f), join(dst, f))
  // Read-only: this copy is what Xcode's navigator opens, and an edit made
  // there builds fine then vanishes at the next sync — the lock sheet turns
  // silent loss into a prompt pointing back at native/core.
  chmodSync(join(dst, f), 0o444)
  n++
}
console.log(`sync-singzcore: ${n} files → ios/SingzCore/core/`)
