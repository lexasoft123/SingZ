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
const { dirname, join } = require('node:path')

const mobileRoot = join(__dirname, '..')
const repoRoot = join(mobileRoot, '..')
const src = join(repoRoot, 'zcore')
const dst = join(mobileRoot, 'ios', 'SingzCore', 'core')
const dspSrc = join(repoRoot, 'zdsp')
const dspDst = join(mobileRoot, 'ios', 'SingzCore', 'dsp')

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
// Private implementation headers under src/ travel beside their translation
// units; they are not exported by the pod but quoted includes must resolve.
copyTree(join(src, 'src'), join(dst, 'src'), name => /\.(cpp|mm|h|hpp)$/.test(name))
copyTree(join(src, 'platform', 'ios'), join(dst, 'platform', 'ios'),
  name => /\.(cpp|mm)$/.test(name))

// Phase 0B compile/link smoke only. This is an explicit allowlist: future DSP
// nodes, the fixture codec and fake host must not silently enter the product
// because a recursive pod glob happened to find them. A component XCFramework
// replaces this broad Phase 0A compatibility pod before Phase 1.
unlockTree(dspDst)
rmSync(dspDst, { recursive: true, force: true })
const dspAllowlist = [
  'include/zdsp/types.h',
  'include/zdsp/events.h',
  'include/zdsp/clock.h',
  'include/zdsp/audio_bus.h',
  'include/zdsp/process_context.h',
  'include/zdsp/processor.h',
  'include/zdsp/latency.h',
  'src/api/contracts.cpp',
]
for (const relative of dspAllowlist) {
  const target = join(dspDst, relative)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(join(dspSrc, relative), target)
  chmodSync(target, 0o444)
  n++
}

// The vendored libFLAC rides along the same way (Phase 5): the pod compiles
// flac/src/*.c and wav.cpp dispatches to it. Directory structure is
// preserved — deduplication/ holds #included fragments the podspec must NOT
// compile, and the include/ tree is what <FLAC/…> resolves against.
const flacSrc = join(repoRoot, 'third_party', 'native', 'flac')
const flacDst = join(mobileRoot, 'ios', 'SingzCore', 'flac')
unlockTree(flacDst)
rmSync(flacDst, { recursive: true, force: true })
copyTree(flacSrc, flacDst, name => /\.(c|h)$/.test(name))
console.log(`sync-singzcore: ${n} files → ios/SingzCore/{core,dsp,flac}/`)
