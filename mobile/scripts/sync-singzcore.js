#!/usr/bin/env node
/**
 * Materialize the top-level zcore package into the SingzCore pod as REAL
 * files. CocoaPods silently
 * drops source_files globs that reach above the podspec dir, and its file
 * lists skip directory symlinks too (both measured: libSingzCore.a shipped
 * without ort_env.o and the app link died on singz::ortProbeJson) — copying
 * is the only shape that works, the same lesson as patch-audio-api.js.
 *
 * Runs from mobile's postinstall. After EDITING files in ../zcore, rerun
 * this + `pod install` (with a SingzCore.podspec version bump so the glob
 * re-evaluates) or Xcode keeps building the stale copy.
 */
const { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const mobileRoot = join(__dirname, '..')
const repoRoot = join(mobileRoot, '..')
const src = join(repoRoot, 'zcore')
const dst = join(mobileRoot, 'ios', 'SingzCore', 'core')

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
let n = 0
const copyTree = (from, to, accept) => {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) {
      copyTree(join(from, e.name), join(to, e.name), accept)
    } else if (accept(e.name)) {
      copyFileSync(join(from, e.name), join(to, e.name))
      chmodSync(join(to, e.name), 0o444)
      n++
    }
  }
}

// Public headers, portable sources and the iOS provider are the pod's only
// inputs. Android/macOS/Windows providers and product bindings never enter
// the Apple artifact.
copyTree(join(src, 'include'), join(dst, 'include'), name => /\.(h|hpp)$/.test(name))
copyTree(join(src, 'src'), join(dst, 'src'), name => /\.(cpp|mm)$/.test(name))
copyTree(join(src, 'platform', 'ios'), join(dst, 'platform', 'ios'),
  name => /\.(cpp|mm)$/.test(name))

// The vendored libFLAC rides along the same way (Phase 5): the pod compiles
// flac/src/*.c and wav.cpp dispatches to it. Directory structure is
// preserved — deduplication/ holds #included fragments the podspec must NOT
// compile, and the include/ tree is what <FLAC/…> resolves against.
const flacSrc = join(repoRoot, 'third_party', 'native', 'flac')
const flacDst = join(mobileRoot, 'ios', 'SingzCore', 'flac')
unlockTree(flacDst)
rmSync(flacDst, { recursive: true, force: true })
copyTree(flacSrc, flacDst, name => /\.(c|h)$/.test(name))
console.log(`sync-singzcore: ${n} files → ios/SingzCore/{core,flac}/`)
