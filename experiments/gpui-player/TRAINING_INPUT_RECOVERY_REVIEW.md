# Vocal training input failure and retry — 2026-11-08

Vocal training now validates its bound native microphone before advancing Cue,
Respond or Completing. Losing input during a reference cue pauses immediately;
losing it during the 250 ms completion hold cannot commit the interrupted vocal
result. The existing session and prior completed results remain available for
explicit Continue. The full desktop goal remains active.

## Defects and implementation

Previously only Preparing and Respond checked input failure. Completing handled
its deadline first and could record the current prompt despite a changed owner,
generation or Error/Off snapshot. Cue could continue after failure until Respond.
Stale Live telemetry was rejected by the scoring gate but could leave the prompt
waiting indefinitely.

The common guard runs before phase advancement and result publication. An active
vocal Cue/Respond/Completing requires the originally bound generation, training
owner, Live state and the existing 500 ms freshness policy. Failure preserves the
actual input error when available, clears pending cue/capture admission and pauses
the retained run. Normal host polling then cancels native cue output and releases
input. Preparing retains its asynchronous-start grace period. Feedback retains
already-committed results. Continue resets current-prompt partial observations,
replays its cue and acquires a new capture generation; it preserves the session ID
and earlier receipts. Identify remains independent of microphone input.

A read-only audit found the original completion/cue defects and confirmed the
new guard and test-only ownership request have no additional concrete issue in
the reviewed source. A separate worker owns the new UI case/driver; root owns
production integration, builds and captures. No new Kimi review was launched.
Shared UIKit appearance and approved native lyrics paint are unchanged.

## Tests and scope

The normal Rust suites pass 783 tests, zero failures and two ignored on both
Mac and Linux. The new unit reaches a real vocal pitch lock, then checks 18
phase/fault combinations: Cue/Respond/Completing versus input Error, Permission,
Off, generation replacement, owner replacement and stale Live data. An expired
completion deadline must not outrank invalid input. It checks pause, original
error, no receipt, cleared gate/cue/waiting and reset partial state on resume.

New connected cases run independently in Cue and Completing. They use native
synthetic A3 PCM replay and real CREPE, not injected pitch telemetry. Prompt one
must score OnTarget with >85% voiced evidence. During prompt two the test requests
an exact-generation fault from the input worker, which kills only its matching
owned non-monitor training child. The real subsequent process/pipe error drives
the host; no synthetic Error snapshot is published. Completing detection and kill
enqueue happen in one UI update without rendering/PID-probe delay and without
extending its deadline.

The same exercise must retain prompt two and the first vocal receipt, pause with
its raw error, cancel cue output and release input to Off. No auto retry or score
is permitted. A limited old-view controller tick occurs only while Paused; this
is not stale-frame injection into the running host. Actual Continue obtains a
fresh input PID/generation and cue generation. Real CREPE completes prompt two,
retains the original first receipt, releases owners and persists exactly one
history entry. Fault/ownership inspection is compiled only with ui-tests and
requires hidden, muted fixture capture; it cannot select a foreign PID.

Independent final validation passes **62 decoded PNGs / 10 apps**, 31 images
and five app processes per platform. It checks 34 checkpoint source pins, both
unchanged shared UIKit source files, native binaries, image dimensions/hashes,
available per-frame state sidecars, actual input PID identities and exactly-once
persisted session history. All final foreground observations stay unchanged;
Linux clients remain unmapped and frameless in their private X server.

| Final case | Mac PNGs / apps | Linux PNGs / apps |
| --- | --- | --- |
| Native input failure in vocal Cue, explicit Continue | 5 / 1 | 5 / 1 |
| Native input failure in vocal Completing, explicit Continue | 5 / 1 | 5 / 1 |
| Existing vocal/Identify/guided lifecycle | 9 / 1 | 9 / 1 |
| Standalone Identify output failure/retry | 5 / 1 | 5 / 1 |
| Song-backed Identify output failure/Settings Retry | 7 / 1 | 7 / 1 |
| Total | **31 / 5** | **31 / 5** |

Observed native input PID replacements are Mac Cue 65950→66033 and Completing
66123→66251; Linux Cue 106→114 and Completing 229→237. Each capture generation
changes 1→3 after failed generation 1 is stopped. Native cue generation also
advances. Both recovered vocal receipts retain OnTarget classification with
>85% voiced evidence. The raw pipe error is retained in the paused view; no
synthetic input error is assigned by the test.

Independent retirement checks cover 25 Mac and 23 Linux observed native owners.
The exact two task containers are stopped, sources/caches retained, foreign host
PID1268/startTicks4023 still owns PCM0p in PREPARED, and other containers are
unchanged. The normal Mac application binary is restored; the user's existing
preview copy is untouched. No source files are staged or committed.
 Existing vocal/Identify/guided training and both standalone/song-backed
output recovery are rechecked against the new guard. No native-heavy build/test
runs concurrently with final captures.

## Visual and performance limits

Paused input error, replayed cue and completed summary are captured at 1280×800
and 1060×640, 2×, with source/binary/fixture/state hashes on the new PNGs. These
are functional candidate screenshots, with no matched production reference and
no pixel-perfect claim. Native-only error localization and presentation remain
open. The user's no-Node/no-Electron instruction governs build and verification;
production component reads establish semantics, not pixel equality.

Available CPU/footprint samples and private Linux process accounting are retained.
Synthetic captures do not establish live display FPS or per-app GPU performance.
Physical microphone input, audible sound, hotplug/permission UI, active recording
failure, song-backed vocal input faults, navigation faults, all training task/state
combinations, latest Windows, hardware GPU/Wayland, full visual/temporal/locale/
accessibility comparison and release packaging remain unqualified. The historical
escaped-child cancellation test's intermittent failure from the previous review
is not considered fixed by this passing run.

Evidence root: `gpui-training-input-recovery-20261108` in the session visualization directory. Linux evidence archive SHA-256: `2f278d5bf59f87ff093258813b503a06b3aa2f08dfe043177bcb4d0e9bad3bbf`.
