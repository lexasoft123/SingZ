# Active training recording failure and retry — 2026-11-08

A late Continue action now leaves an already-running exercise and microphone
capture unchanged. An active recording failure is additionally qualified through
the native recording/export workflow on Mac and Linux. This checkpoint preserves
the full desktop objective; it does not provide crash salvage for RAM-only audio.

## Production fix

`continue_practice` previously incremented `mic_serial` even when `Run::resume`
did nothing outside Paused. A late action could restart active input; the bound
capture guard correctly rejected that replacement, but the exercise then paused
unnecessarily. `Run::resume` now reports whether it reset an active paused prompt;
the host increments capture intent only on true. The new unit checks rejection
in Preparing, Cue, Respond, Completing, Feedback and Summary, and one successful
Paused→Preparing transition without changing the session ID.

A read-only agent confirmed the defect and checked callers: the host is the only
production caller, and Continue renders only in Paused. A separate worker authored
the new UI test/driver, with root integrating, building and capturing. The paused
error paragraph gained a test-only geometry probe; reusable controls and visual
tokens remain in shared UIKit. No lyrics highlighting or DSP changed.

## Recording failure semantics

The shared native `CaptureRecording` stores bounded raw mono PCM in memory until
finish/save. Abrupt helper death before finish leaves no current WAV. This is
not recoverable by restarting a controller. The test explicitly requires no new
WAV, no misleading Save control and a reported failure. It does not claim the lost
active audio survived. Previously completed WAVs and their exports remain on disk.
The source Electron component also clears its prior export control when a new
recording starts; the native app keeps that behavior.

Graceful device failure differs: the helper's normal stop path attempts to finish
and returns a recording receipt. That path is source intent, not covered by the
abrupt-kill runtime case. A separate open gap is finalized WAV publication failure:
staged `.take-*` or helper `.writing-*` audio may remain with an Error path, but no
structured exportable Take. Future recovery must validate/promote the owned WAV
into the normal retained root; arbitrary staged paths must not bypass export-root
validation. Incremental disk spooling/crash salvage would be additional work.

## Verification

Normal Rust suites pass 784 tests, zero failures, two ignored per platform. The
new connected test uses the real native helper and CREPE over off-target 330 Hz
mono PCM so the A3 exercise remains in Respond. Actual controls perform:

1. Record/Stop a first take and Save it with the real export worker.
2. Start a second accepted recording, inspect its worker-owned input PID, and kill
   exactly that current-generation non-monitor training child.
3. Require the same exercise paused with its real input error; input Off, cue
   cancelled, no recording/busy/export pending, no new WAV or phantom Save. The
   first completed native WAV and its prior export remain byte-exact.
4. Actual Continue acquires fresh input. A limited direct stale Continue event
   after Respond must leave capture generation, mic serial, session and phase
   unchanged. This represents a queued old action, not a second rendered click.
5. Actual Record/Stop creates take three, then Save uses the worker to export exact
   bytes. The old error is gone; no operation remains pending. Actual Exit releases
   input/output and preserves the two finished native WAVs.

The Save path uses the established test chooser seam; the actual Save control and
export worker run, but an OS-owned dialog is not qualified. Both originals/exports
are decoded and checked as native mono PCM16, 16 kHz, 0.1–30 seconds, with expected
RMS and 320–340 Hz positive zero crossings. The seven new frame sidecars carry
source/binary/fixture identities and fresh layout geometry. Failure frames check
recording bar/status, paused error and Continue; Respond frames check guidance
and dock. Unrendered Paused guidance/dock bounds are not treated as fresh evidence.

Independent final validation passes **76 decoded PNGs / 10 app launches**, with
38 images/five apps on each platform. It checks 41 checkpoint source files, both
unchanged shared UIKit files, native binaries, image hashes/dimensions, available
state sidecars and exact input PID ownership. All final foreground observations
stay unchanged; Linux windows remain unmapped and frameless. New-case layout
checks pass at both content sizes with no recording/status/error/action overlap.

| Final case | Mac PNGs / apps | Linux PNGs / apps |
| --- | --- | --- |
| Active recording input death, Continue, fresh take/export | 7 / 1 | 7 / 1 |
| Existing Record/Stop/export/keyboard/navigation workflow | 12 / 1 | 12 / 1 |
| Vocal input failure in Cue | 5 / 1 | 5 / 1 |
| Vocal input failure in Completing | 5 / 1 | 5 / 1 |
| Vocal/Identify/guided lifecycle | 9 / 1 | 9 / 1 |
| Total | **38 / 5** | **38 / 5** |

The new recording case observes Mac input PID81340→81406 and Linux106→114,
capture generation1→3. A queued old Continue leaves that fresh generation and
intent serial unchanged. The first completed native take and recovered third
take are independently decoded from preserved artifacts: Mac 0.352/0.480 seconds,
Linux 0.416/1.408 seconds, mono PCM16/16 kHz, measured 329.3–332.4 Hz and RMS
5652–5655. Both exports match their originals byte-for-byte. Failed active take2
has no WAV or Save control; neither driver nor review claims audio salvage.

Independent retirement checks cover 31 Mac and 32 Linux observed native owners.
The exact two task containers are stopped; source/caches remain, foreign host
PID1268/startTicks4023 retains PCM0p in PREPARED, other containers unchanged.
The normal Mac binary is restored and the user's preview copy is untouched.

Existing Record/Stop/export/navigation, input failure in Cue/Completing and the
vocal/Identify/guided lifecycle are rechecked. All tests are hidden, muted and
app-local; native-heavy builds/tests finish before final captures.

## Remaining qualification

These are functional candidate captures, with no matched production reference,
pixel-perfect or live-FPS claim. Available process CPU/footprint observations are
retained; per-app GPU and display cadence remain unmeasured. Physical microphone,
audible monitoring, hotplug/permissions, actual choosers, graceful capture-error
finalization, finalized-stage recovery, song-backed recording/faults, all training
task/state combinations, live services/models, latest Windows, full visual/
temporal/locale/accessibility comparison and release packaging remain open.
The older intermittent escaped-child cancellation assertion is not considered
fixed by the current passing suites. No source is staged or committed, and the
user preview copy remains untouched.

Evidence root: `gpui-recording-recovery-20261108` in the session visualization directory. Linux archive SHA-256: `ac92a06e47101590dfe94b43fd7dc35649d5f7dc234d25db209aa646e94adf06`.
