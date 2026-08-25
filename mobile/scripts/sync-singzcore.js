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
const { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const src = join(root, 'native', 'core')
const dst = join(root, 'ios', 'SingzCore', 'core')

// The previous materialization is intentionally read-only. Some Node/macOS
// combinations refuse recursive removal of those files even though the parent
// directory is writable, so explicitly unlock only this generated tree.
const unlockTree = (dir) => {
  if (!existsSync(dir)) return
  chmodSync(dir, 0o755)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) unlockTree(path)
    else chmodSync(path, 0o644)
  }
}
unlockTree(dst)
rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
let n = 0
for (const f of readdirSync(src)) {
  if (!/\.(h|hpp|cpp|mm)$/.test(f)) continue // android/ subdir (JNI shim) stays out
  copyFileSync(join(src, f), join(dst, f))
  // Read-only: this copy is what Xcode's navigator opens, and an edit made
  // there builds fine then vanishes at the next sync — the lock sheet turns
  // silent loss into a prompt pointing back at native/core.
  chmodSync(join(dst, f), 0o444)
  n++
}

// The vendored libFLAC rides along the same way (Phase 5): the pod compiles
// flac/src/*.c and wav.cpp dispatches to it. Directory structure is
// preserved — deduplication/ holds #included fragments the podspec must NOT
// compile, and the include/ tree is what <FLAC/…> resolves against.
const flacSrc = join(root, 'native', 'third_party', 'flac')
const flacDst = join(root, 'ios', 'SingzCore', 'flac')
unlockTree(flacDst)
rmSync(flacDst, { recursive: true, force: true })
const copyTree = (from, to) => {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) {
      copyTree(join(from, e.name), join(to, e.name))
    } else if (/\.(c|h)$/.test(e.name)) {
      copyFileSync(join(from, e.name), join(to, e.name))
      chmodSync(join(to, e.name), 0o444)
      n++
    }
  }
}
copyTree(flacSrc, flacDst)
console.log(`sync-singzcore: ${n} files → ios/SingzCore/{core,flac}/`)
