# Advisory native analyzer provenance

The native app now mirrors the existing analyzer-only advisory check. Pitch,
key and beat resolution schedule diagnostics on one bounded background worker;
they do not await or refuse analysis because of a diagnostic verdict.

The Python producer explicitly supplies the canonical source hash on every
CMake configure, including reused caches. It recomputes the hash after the
build and verifies the built analyzer and the temporary destination copy before
replacing the published analyzer. Existing relative codec staging is preserved.
The producer checkpoint is `e3c5a853`; its eight isolated Python tests pass.

The app build invokes the same `scripts/analyze-source-hash.sh` without Node and
tracks its canonical input roots with Cargo. Missing build-time tooling yields
an unchecked expectation. Installed users need no source tree. Windows POSIX
tool priority changes belong only to the hash subprocess.

The runtime worker hashes executable content, memoizes at most 64 identities,
and checks identity again after probing. A same-path replacement is rechecked.
The queue holds at most 16 paths; a full queue never delays analysis. The probe
uses the existing owned-child lifecycle with a ten-second timeout and 16 KiB
output limit. Binary answers take priority: an answered-null hash stays unknown
even beside a matching sidecar. Unknown expectations never claim a match.
Mismatch, unknown and unchecked results go to existing diagnostics.

Saved pitch/key/beat detector versions, current/future-stamp handling, source
size/mtime and load-epoch fences remain unchanged. This is not cache invalidation
or a new three-helper protocol.

## Verification and remaining scope

Evidence is retained under
`/tmp/singz-native-tour-a11y-20261109/provenance-consumer-v1` and `v2`.

- All seven new Rust tests pass, including actual synthetic helper answers,
  same-path content replacement, answered-null priority, bounded hanging child
  and overflowing output.
- The complete permitted macOS suite passes 1,020 tests, zero failures and two
  installed-model ignores in 48.65 seconds.
- The initial focused command mistyped the module filter and selected zero
  tests. The first full run then failed 113 existing process/loopback fixture
  cases under restricted local permissions. Both rejected observations remain
  retained; the corrected filter selects seven tests, and the permitted full run
  changes no assertions, deadlines or compiled source.
- Independent working and exact-staged Rust reviews report zero findings.
  UI-enabled checking and the ordinary application build are recorded separately
  in the controller result; an in-progress phase is not a pass.

## Graceful shutdown and real-helper follow-up

The application quit/release hook now cancels the diagnostic service and joins
its active owned-child cleanup before draining diagnostics. Queued and future
probes are suppressed, including shutdown before first service initialization.
Hashing and the existing bounded child runner both observe cancellation; normal
alignment callers retain their existing defaults. This closes the detached
worker's application-exit lifecycle gap.

The shutdown follow-up passes eight focused tests and the full 1,021-test suite,
zero failures and two installed-model ignores, followed by normal and UI builds.
The new test waits for actual probe parent/descendant startup, checks their
private group/start identities, then verifies retirement and absence of queued/
future execution. The source stayed frozen throughout.

The real macOS producer build also passes built/staged analyzer validation.
Its existing `build-info` reports source hash
`a2a60fbffaf4996d4fb98f93df006631a326a656`, matching the embedded app expectation;
pitch/key/beat versions remain 4/2/23. The same canonical hash is independently
computed from the exact public Windows archive without Git metadata after
installing Git in the existing user-local build toolchain.

The maintained hidden/muted native analysis journey passes real vocal detection,
pitch view and keyboard Save with the stamped helper. Its slow-analyzer case
verifies four recorded analyzer processes are gone after replacement and app
quit. Evidence: `provenance-shutdown-v1`, `provenance-helpers-v1-build.log`,
`provenance-real-helper-v1.json`, `dell-verify-analyzer-hash-v1.host.log` and
`provenance-shutdown-native-analysis-v1` in the scratch directory above.

Windows/Linux stamped-helper staging and runtime diagnostic evidence remain
required. Neither synthetic helper tests nor the separate passed Linux canonical
decoder matrix closes those target gates. No physical input or foreground UI
was used; output stayed muted and no Node/Electron execution was needed.
