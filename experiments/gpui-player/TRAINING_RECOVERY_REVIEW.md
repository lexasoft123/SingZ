# Training output failure and explicit retry — 2026-11-08

The native app now retains an interrupted exercise and completed answers when its
owned output helper fails. Standalone exercises retry the current prompt through
Continue. Song-backed exercises require successful output repair in Settings;
Continue stays disabled until the retained song is ready. The full desktop goal
remains active.

## Defect and implementation

The worker reports TransportFailed before its generation-specific Training error.
The old host cancellation revoked that generation first, dropping the detailed
error. The generic notice also directed standalone training to a Settings recovery
path that requires a loaded project. Song-backed Continue could instead prepare a
standalone cue while the retained song output was still failed.

The host records the original failure on the existing paused Run before ignoring
stale generation receipts, and provides guidance appropriate to song ownership.
A shared readiness gate protects Start, test cues, Continue, practice polling and
microphone availability while song recovery/publication is pending. Continue
resumes the existing Run, preserving its session ID and completed receipts. The
shared UIKit training primary factory supplies the disabled appearance; the screen
only attaches Continue's handler when output is available. No lyric paint changed.

The targeted read-only agent audit found the original ordering/guidance/readiness
findings closed in source. A separate worker authored the new recovery UI module
and driver; root integrated, corrected fixtures, built and captured. No new Kimi
review was launched after the provider quota from the preceding checkpoint.

## Coverage and evidence

Final functional evidence contains **88 decoded PNGs / 14 app launches**: Mac 46/7 and Linux 42/7. The independent manifest verifies 31 checkpoint source pins, both shared UIKit files, native binaries, image hashes/dimensions, available state sidecars, native probes and persisted history. This is artifact/functional verification, with the foreground qualification gap below retained. Normal suites pass 782 tests, zero failures, two ignored per
platform. The new unit regression preserves a completed Identify receipt, current
prompt and session identity across failure/resume, and rejects an older cue.

The two new connected UI cases use Identify with two prompts. Actual Start and
first-answer controls produce one correct receipt; the test faults only the
backend-owned native helper during prompt two. The retained run must remain paused
with its specific error, original receipt and session identity. Escape dismisses
the notice. Standalone Continue starts a fresh native helper/cue generation.
Song-backed Continue is tested as an actual disabled click and a limited direct
event; both must be blocked until actual Settings Retry restores the retained
song graph paused. Its dirty mix, metadata hash, edit bookkeeping, seek position,
tempo, transpose and accepted full-song loop must survive. Explicit Continue then
replays prompt two and completing it persists one history receipt for the same
session. Native helper PIDs are cross-checked against independent observers.

The new cases leave microphone input Off and intentionally do not qualify vocal
failure recovery. The old native training regression separately exercises real
CREPE over synthetic PCM capture, correct vocal scoring, completion hold, owner
release, restart, leave/pause, Identify and guided target advancement. Physical
microphone input remains unqualified. Stale-receipt checks call the controller
with an old captured status; they are not native stale-receipt injection.

| Final functional case | Mac PNGs / apps | Linux PNGs / apps |
| --- | --- | --- |
| Standalone Identify failure and explicit Continue | 5 / 1 | 5 / 1 |
| Dirty song-backed Identify failure, Settings Retry, Continue | 7 / 1 | 7 / 1 |
| Existing vocal/Identify/guided training lifecycle | 9 / 1 | 9 / 1 |
| Existing document, restart and offline publication recovery | 19 / 3 | 19 / 3 |
| Monitoring Save / Linux unavailable-platform policy | 6 / 1 | 2 / 1 |
| Total | **46 / 7** | **42 / 7** |

Final Mac sources use one v4 binary: standalone comes from `mac-ui-v4-final`,
song-backed from `mac-ui-v4-retry-song`, and remaining cases from
`mac-ui-v4-regressions`. The song driver completes its assertions and retains all
seven hidden/inactive frame sidecars, but the outer foreground observer detects
an intervening application switch. Its strict foreground qualification is
**interrupted, not passed**; the independent manifest explicitly records
`foregroundUnchanged=false`. Other final Mac cases and all Linux cases have
stable foreground observations. No blanket unchanged-focus pass is claimed.
Earlier interruptions identify Codex/iTerm2 and Chrome/Telegram read-only; the
selected song observation's identities are retained separately. No foreground
window was activated by the tests, and no guard was weakened to pass.

Native recovery PIDs: Mac standalone 50495→50556, song 51266→51362;
Linux standalone 1061→1066, song 1179→1190. Cue generation advances 2→3;
standalone has two fresh probes, song-backed three including the repaired paused
song. Independent retirement checks cover 31 final Mac observed owners
(107 including intermediate batches) and 23 final Linux owners. The exact two
task containers are stopped, sources/caches retained, foreign host
PID1268/startTicks4023 still owns PCM0p in PREPARED, other containers unchanged.
The ordinary monitoring workflow is qualified only on Mac with synthetic input;
Linux's two images cover its production disabled-platform policy.

## Preserved intermediate failures

Version 1 song recovery correctly restored the full-song native loop [0,12], but
the harness compared it to an absent optional project selection. Version 2 checks
the accepted native loop captured before failure. Version 2 Linux's existing
vocal regression then failed before Start because it used a Mac-specific header
coordinate. Version 3 measured the initial Training control; Linux then exposed the two remaining fixed navigation coordinates after successful vocal completion. Version 4 measures all Songs/Training navigation controls on both platforms. No
production guard or assertion deadline was relaxed. Intermediate evidence stays
immutable and excluded from final counts. A v4 Mac batch was also interrupted by the foreground guard when the user switched between Codex and iTerm2 (identified read-only through LaunchServices); all observed native owners retired, and a fresh same-binary batch retains the unchanged foreground guard.

The first v4 Linux normal-suite attempt had one failure in the existing escaped-descendant cancellation assertion (781 passed, one failed, two ignored). It passed in isolation, then the unchanged full suite passed 782/0/2. The first failure and isolated/full logs are preserved; its intermittent cause is unresolved and no assertion or deadline was weakened.

## Visual and performance scope

The new failure notices, disabled Continue, repaired Settings, replayed cue and
summary are functional candidate captures at 1280×800 and 1060×640, scale 2.
They have no matched production screenshots and establish no pixel-perfect parity.
The review procedure's Electron capture path is superseded by the user's no-Node,
no-Electron instruction; source inspection alone does not close that visual gate.
Recovery copy and native-only error presentation remain localization work. The new recovery PNGs have full per-frame state/source/binary sidecars; the older training-run PNGs rely on their driver result/fixture and observer rather than that richer per-frame metadata.
Hidden screenshots do not measure live FPS/display cadence. Available process CPU
and footprint samples are retained; helper accounting differs by platform and
system GPU samples cannot qualify per-app GPU cost. Hardware GPU, Wayland and
latest Windows remain open.

## Remaining full-desktop requirements

This checkpoint closes only owned-output failure and explicit retry for Identify,
plus the listed existing regressions. Vocal/microphone/recording failure recovery,
other-screen navigation faults, physical devices/hotplug/permissions, actual
choosers and services/models/live Google, all training task/state combinations,
full visual/temporal/locale/accessibility comparison, latest Windows and release
packaging remain open. The approved native continuous partial-glyph highlight,
advancing glow and brighter leading/final glyph remain the lyrics standard.

Evidence root: `gpui-training-recovery-20261108` in the session visualization directory. Linux archive SHA-256: `0b503e21b695718ca683e401deee597856a79a2e22f5a4e8853a98847c0249ac`. No files staged or committed, and the user preview app is untouched.
