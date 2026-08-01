/*
 * Make Xcode's pod builds share one ccache across worktrees.
 *
 * RN's Podfile ccache_enabled points CC/CXX at react-native's own
 * scripts/xcode/ccache-clang.sh, which exports CCACHE_CONFIGPATH to react-
 * native's ccache.conf. That REPLACES the machine's ccache config, so
 * anything set with `ccache --set-config` is invisible to a pod build — and
 * env vars don't help either, since a build started from Xcode.app inherits
 * no shell environment. Appending to that conf is the only channel that
 * reaches both xcodebuild and the GUI.
 *
 * What the block buys: CMake/Xcode compile with absolute paths and Debug
 * adds -g (which hashes the CWD), so two checkouts share the cache directory
 * while hitting nothing in it. base_dir hashes paths under this checkout
 * relative, hash_dir drops the CWD — together they were measured to turn a
 * cold sibling-worktree compile into a hit.
 *
 * Trade-off (documented in docs/DEVELOPMENT.md): a reused object carries the
 * debug info of whichever worktree compiled it first, so lldb can open a
 * sibling's copy of a source file. Harmless while they agree, confusing when
 * they differ — `git checkout` the worktree you're actually stepping in.
 *
 * node_modules is disposable and gitignored: this rewrites nothing outside
 * the project and re-applies on every npm ci. Runs from postinstall;
 * idempotent (the marked block is replaced, never stacked).
 */
const fs = require('fs');
const path = require('path');

const conf = path.join(
  __dirname,
  '..',
  'node_modules/react-native/scripts/xcode/ccache.conf'
);
const ROOT = path.resolve(__dirname, '..', '..'); // this checkout (worktree) root
const BEGIN = '# >>> SingZ (scripts/ccache-xcode-conf.js) — cross-worktree hits';
const END = '# <<< SingZ';

if (!fs.existsSync(conf)) {
  // RN moved or renamed it: pods still build, they just cache per-worktree.
  console.log('ccache xcode conf: react-native ccache.conf not found — skipped');
  process.exit(0);
}

const block = [
  BEGIN,
  `base_dir = ${ROOT}`,
  'hash_dir = false',
  'compiler_check = content',
  END
].join('\n');

// Cut previous blocks by marker position, not by regex — the markers carry
// parens and dots, and as a pattern they silently matched nothing and
// stacked a fresh block on every npm ci. Loops, so an already-stacked file
// heals in one run.
const strip = (text) => {
  let out = text;
  for (;;) {
    const from = out.indexOf(BEGIN);
    if (from === -1) return out;
    const to = out.indexOf(END, from);
    if (to === -1) return out.slice(0, from); // truncated block: drop the tail
    out = out.slice(0, from) + out.slice(to + END.length);
  }
};

const src = fs.readFileSync(conf, 'utf8');
const next = `${strip(src).replace(/\n+$/, '')}\n\n${block}\n`;

if (next === src) {
  console.log('ccache xcode conf: already current');
} else {
  fs.writeFileSync(conf, next);
  console.log(`ccache xcode conf: base_dir=${ROOT}, hash_dir=false`);
}
