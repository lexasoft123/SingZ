# Native integration

The application runtime is Rust/GPUI plus `singz-gpui-audio`, a standalone C++
process linked to the existing `NativePlaybackSession`, zCore and zDSP. Model
inference uses the existing installed Python splitter pack. There is no Node,
Electron, N-API or web renderer in this path. The dedicated build uses
Cargo, CMake, a C++ compiler and a shell wrapper; npm is not required.

```sh
bash scripts/build-gpui-audio.sh
cargo build --locked --manifest-path experiments/gpui-player/Cargo.toml
experiments/gpui-player/target/debug/singz-gpui-player
# Or open a particular project:
experiments/gpui-player/target/debug/singz-gpui-player --project /path/to/project
```

The build installs singz-gpui-audio, singz-gpui-input, the existing singz-analyze CLI,
and the shared CREPE tiny model and license under pitch/.
The helper defaults to the UI executable's directory. For a release build, pass
`experiments/gpui-player/target/release/singz-gpui-audio` to the build script.
`SINGZ_GPUI_AUDIO_HELPER` can select an explicit helper executable.

SINGZ_GPUI_ANALYZER can override the analyzer executable for deployment/testing.

The native catalog reads `~/Documents/SingZ`, or `SINGZ_GPUI_PROJECTS_ROOT`.
Open accepts audio, a project directory or its project.json, through the picker,
file drop, or `--project`. Loose audio becomes an unsaved private working project;
Save publishes it into the library without overwriting an existing song. Reads are performed
on a worker thread. Explicit Save updates known settings in place, preserving unknown
metadata, source hashes and numeric precision. WAV/FLAC
stems use the existing native decoders, with FLAC preferred when both exist.
Source-only projects can use the codecs enabled in this native build. Default
helper builds require the pinned FFmpeg SDK; `--basic-only` selects the reduced
development runtime. See [desktop packaging](DESKTOP_PACKAGING.md) for qualified
formats and remaining platform delivery work.

Implemented: native prepare, real duration and waveform summaries, Play/Pause,
seek, saved selection loops, master volume, lane mute/solo/volume, reset, tempo and
transpose. Running tempo/transpose changes replace the prepared graph on the same
stream and reuse decoded sources; paused state, loop intent and mix are retained.
Preparation starts paused and uses the selected native output endpoint and its rate.
An empty saved UID selects the current system default; Play rechecks the default
so a graph prepared before a device change is not reused on the old endpoint.
The UI uses native audible project time when current, with rendered-time/latency
fallback and seek/run guards during clock edges; bounded interpolation fills the
interval between telemetry replies. File decoding and control IPC never block
rendering. A new load retires the old process before preparing another output
owner. Requests and results carry Rust load epochs; obsolete results are ignored.
Quitting joins the worker and kills/waits for its owned helper.

The helper uses a private, versioned protocol: bounded ASCII control lines on
stdin and JSON receipts/status on stdout. Paths are separate argv entries, with
no shell parsing. Maximum command length is 4096 bytes; Rust caps replies at
1 MiB and applies prepare/control deadlines. Telemetry uses a single replaceable latest snapshot, carrying its receipt time,
so a stalled UI catches up instead of replaying the oldest queued clock. Older
telemetry cannot undo a newer route receipt or resurrect a failed project. `SINGZ_MUTE` forces
native master gain to zero even after later master-volume commands.

Saved lyrics.json timing now drives the approved native partial-glyph renderer,
including fallback glyphs, advancing core/glow, word halos and tap-to-seek. Glyph
masks are prepared off the render thread with bounded texture caches. Saved pitch
is decoded using the production cents/gap format and version/coverage guards;
key, tempo, note range and piano roll follow actual tempo/transpose.

Save (button or Cmd/Ctrl+S) persists mix, tempo, transpose, view and loop state.
It checks the original metadata fingerprint before atomic replacement and reports
external-edit conflicts. User edits use explicit Save; accepted automatic analysis is persisted into existing
projects through the serialized Save queue. A separate native Drive worker
reconciles durable sync intent when configured and signed in. See
[Drive qualification](DRIVE_PORT_REVIEW.md) for its current limits. Unknown metadata
and large numeric fields survive; Save does not migrate the project format.

Missing/stale vocal pitch is analyzed on a separate worker through singz-analyze.
Analysis does not block transport, is bounded by a timeout/output limit, and is
cancelled on project replacement or shutdown. File size/mtime must match the
source captured at load and remain unchanged through analysis; load epochs prevent
stale adoption. Newer detector results are retained. Detected pitch becomes a
working edit and is automatically persisted into an existing project, preserving
concurrent mix edits. Loose imports remain private until explicit Save.
Native beat re-detection and lyrics lookup/transcription/alignment are connected
as described below. Missing or stale harmonic keys are analyzed independently of vocal pitch as
described in the automatic-analysis completion note below.

Settings now displays real native AudioHost inputs/outputs and channel counts.
Merely opening it does not pause playback. Choosing an output explicitly rebuilds
on that endpoint, preserving project seconds across sample-rate changes plus mix,
loop, tempo and transpose, and stays paused until Play. Missing selections are
validated before teardown and retain the working route; a missing saved device
refuses project prepare and can be repaired in Settings without silent fallback.
Native playback stays enabled; its source-layout checkbox is checked/disabled.
The header reports the actual endpoint label. Shared UIKit modal scrims occlude
pointer input, including error notices over Settings. This is an explicit stream rebuild,
not a seamless device handoff. Microphone capture is connected as described below;
experimental same-device monitoring uses the exclusive handoff described below.

Output preferences live in a separate native app configuration directory:
macOS `~/Library/Application Support/SingZ-GPUI`, Windows `%APPDATA%/SingZ-GPUI`,
Linux `$XDG_CONFIG_HOME/singz-gpui` (or `~/.config/singz-gpui`).
`SINGZ_GPUI_CONFIG_DIR` selects an isolated directory for tests/deployment.
Explicit output/input choices write `audio.json`; writes lock, preserve unknown
fields, sync and atomically replace the file. Enumeration runs on its own worker
and uses a cancellable native process, never the UI or transport command queue.

Microphone capture uses zCore AudioInput and the existing zDSP CREPE tiny module in
`singz-gpui-input`. PCM stays inside the native process; bounded JSON replies carry
only coherent pitch, level, channel, timing and route metadata. Settings passively
previews the selected input when permission already exists. An explicit Enable/Retry
or player microphone click can request permission; opening Settings never prompts.
The player displays the live trail and octave-wrapped pitch matching while playing.
Settings owns a separate capture generation and closing it restores requested player
matching. Stop/replacement reaps the previous helper before another input owner starts.

Saved input UID/channel choices preserve unrelated preferences. Invalid/missing
routes report errors rather than retaining old meter/pitch data. Both native frame
age and receipt age gate freshness; an unchanged sequence cannot renew stale data.
macOS permission querying/requesting uses AVFoundation. The shared Linux ALSA
playback/capture provider is restored; its current Linux build and runtime
qualification are in progress. Windows monitoring retains its existing
qualification refusal. Windows capture has been exercised with native PCM replay;
physical microphone capture remains unqualified.

Experimental headphone monitoring uses the existing pure-C++ AudioMonitorSession.
Choose a same-device duplex input/output route, distinct physical output channels,
and confirm wired headphones before Start. Confirmation is transient: route edits,
Stop, and reopening Settings clear it. Saved confirmation is never trusted.
Starting first stops/reaps input preview, then waits for playback's physical-output
release receipt, retaining decoded song audio and current transport/mix state.
The monitor owns the output only after that receipt. Gain updates use the existing
native ramp without restarting the monitor generation; pre/post RMS and actual
buffer size are shown in the graph. SINGZ_MUTE keeps monitoring disabled and its
post output at zero, including after gain changes.

Stop, leaving Settings, native monitor refusal and project replacement all reap
monitoring before restoring the retained playback graph paused. Explicit Play is
required to resume. Playback commands, output choices and project loads during a
handoff wait in a bounded queue; native output-opening controls refuse while
parked, and backend dispatch also fences project/output changes behind the lease.
Park receipts prove physical output release with no quarantine/other retained graph;
they deliberately retain decoded PCM and are not globally-empty fallback leases.
There is no alternate playback/DSP path. Unsupported routes retain the core's
provider/platform refusals and restore playback paused.

Saved format-1 graph playback is now connected; see [native graph qualification](NATIVE_GRAPH_REVIEW.md).
Still incomplete: explicit graph-edit API integration and full topology/platform qualification, general song recording, key re-detection,
provider/device-loss recovery, live/platform Drive qualification and packaging.
Connected training, splitting, project import/storage, beat detection and lyrics
paths are described below; their remaining states and platform coverage are not
complete.
Projects with saved unsupported playback semantics are rejected explicitly.
An audio-helper or unrecoverable host failure stops the session and reports an error; there
is no simulated playback or alternate output fallback. File-picker behavior and
Windows/Linux runtime playback still require platform verification.

The existing visual fixture remains available with `SINGZ_GPUI_DEMO=1`; review,
smoke and benchmark adapters select it automatically. Approved native lyric
rendering is unchanged. Native integration checks use a separate adapter and
never select the fixture mode.

## Verification (no Node)

```sh
cargo test --locked --manifest-path experiments/gpui-player/Cargo.toml
python3 experiments/gpui-player/tests/test_native_audio.py \
  experiments/gpui-player/target/debug/singz-gpui-audio
# Actual output device, forced silent:
python3 experiments/gpui-player/tests/test_native_audio.py \
  experiments/gpui-player/target/debug/singz-gpui-audio --hardware

cargo build --locked --features ui-tests --manifest-path experiments/gpui-player/Cargo.toml
python3 experiments/gpui-player/tests/test_native_monitor_ui.py \
  experiments/gpui-player/target/debug/singz-gpui-player /tmp/singz-native-monitor-ui
python3 experiments/gpui-player/tests/test_native_monitor.py \
  experiments/gpui-player/target/debug/singz-gpui-audio \
  experiments/gpui-player/target/debug/singz-gpui-input /tmp/singz-native-monitor
# Optional real muted same-device duplex handoff; requires existing permission:
# append --hardware --hardware-monitor to test_native_monitor.py
python3 experiments/gpui-player/tests/test_native_microphone.py \
  experiments/gpui-player/target/debug/singz-gpui-player /tmp/singz-native-microphone
python3 experiments/gpui-player/tests/test_native_input.py \
  experiments/gpui-player/target/debug/singz-gpui-input /tmp/singz-native-input
python3 experiments/gpui-player/tests/test_native_settings.py \
  experiments/gpui-player/target/debug/singz-gpui-player /tmp/singz-native-settings
python3 experiments/gpui-player/tests/test_native_analysis.py \
  experiments/gpui-player/target/debug/singz-gpui-player /tmp/singz-native-analysis
SINGZ_MUTE=1 SINGZ_GPUI_BACKGROUND=1 \
SINGZ_GPUI_TEST_PROJECT=/path/to/isolated/test-project \
SINGZ_GPUI_INTEGRATION_TEST=/tmp/singz-native-ui \
  experiments/gpui-player/target/debug/singz-gpui-player
```

The Python helper test creates its own waveform; the hardware option additionally
checks advancing audio time, stable pause, seek, loop, completion, restart and
tempo/transpose swaps that retain stream identity.
The hidden GPUI adapter checks the real bridge, shared Play/Pause and M buttons,
seek, tempo/transpose UI state, superseded generations, failed-load cleanup and
renderer captures. SINGZ_GPUI_TEST_SAVE=1 additionally tests the actual keyboard
shortcut and external-edit conflict protection; use an isolated project because
this test writes it. SINGZ_GPUI_NATIVE_LYRICS=/tmp/frames selects the separate
saved-lyrics adapter, sampling word paint at 120 Hz while native seeks settle.
SINGZ_GPUI_TEST_ANALYSIS=1 waits for actual vocal detection and, combined with
the Save option, checks persisted detector metadata. These
checks establish integration behavior, not Electron pixel parity or live FPS.

Microphone verification replays generated mono PCM through the actual native CREPE
module, checks player scoring, Settings ownership handoff, painted meter pixels,
invalid-channel stale-data clearing, corrected preference persistence and Stop.
This fixture opens no microphone hardware. `test_native_input.py --hardware` also
supports a brief real default-input check without requesting permission. A verified
2-second macOS capture had 98 frames and zero overruns; that is not multichannel,
monitoring, other-platform or live display qualification. CPU diagnostics are
one-core process usage; hidden stepped captures do not measure live FPS or GPU.

Monitoring verification checks both real native playback + fake duplex monitoring
in the hidden interface, and a separate real CoreAudio playback-to-duplex-to-playback
handoff with forced-silent output. Checks cover retained position/mix/loop/rate,
repeated Park, refusal of controls while parked, live gain with stable generation,
native startup refusal restoring paused, explicit resume and project replacement.
The short real-device test is not audible monitoring, sustained latency, other-device
or other-platform qualification. Hidden screen regression remains separate from
full Electron parity and live display FPS/GPU measurements.

The Vocal training navigation now opens native Home, seven source-backed exercise
setup routes and empty Progress. Initial Foundation/Developing/Advanced curricula,
key/mode/task/direction/range/instrument/tolerance/length controls and popup-first
Escape are implemented. Shared cards, choices, source icons and native font weights
live in UIKit, including distributed 600/650/720/760 mono and 720 display faces.
The setup action footer stays fixed while the form scrolls.

Start and Test C4 are connected to native reference rendering/cue scheduling.
Start also connects exclusive microphone capture, scoring and running/result views.
Completed progress and setup now persist natively. Training sample recording is
implemented with hidden UI/direct input checks passing as described below; selected-song preparation is connected below. The production Electron renderer still renders phrases
in browser audio before passing PCM to TrainingPcmMixer/SharedAudioService; this
native app uses the C++ renderer below and contains no N-API/browser rendering.
Older memory describing pre-existing standalone native instrument cues did not
describe this checkout. No Node was used to build or test these screens.

The offline native reference-rendering building block is now implemented in
`native/playback/training_phrase_renderer.{h,cpp}`. It plans source cue purpose
gaps/articulation, renders the 15 bundled MP3 roots through the existing native
decoder, applies calibrated gain/sample envelopes, and synthesizes the source
organ registration/envelopes with 2x waveshaping and the shared native resampler.
Calibration tables and boost are generated from the shared source using
`python3 scripts/gen-training-levels.py` (`--check` detects stale output).
It accepts bounded authorized decoded samples; rendering cancellation discards the whole
PCM/timeline. It does not own a device or run in a callback. Native tests verify
all 15 roots, gaps, gain, stereo, envelopes, cancellation, bounds and delivery
through TrainingPcmMixer, including future onset and callback jitter. Sample interpolation
and organ filtering differ from Chromium; audible/PCM fidelity remains unqualified.

The standalone audio helper now uses one local SharedAudioService physical owner
for both the song client and training mixer. Its bounded `cue`, `cue-gain` and
`cue-cancel` commands render bundled instruments natively and return a generation,
lossless host-clock strings, callback-owned activity, note timeline and separate
physical output latency. Stale cancellation/gain cannot affect replacements.
Cancellation uses the mixer's 5 ms ramp before draining the callback, with a
bounded fallback if callbacks have stopped. SINGZ_MUTE applies to live cue gain.
The build copies the 15 samples, calibration and license beside the helper.

Park clears cues, unloads the song client and stops the base service; a safe base
host state is required in addition to the existing session cleanup proof. The
helper disables the service's automatic endpoint fallback and refreshes inventory
before explicit Play/cue/route actions. Route replacement now preserves the
latency-compensated audible position even when precise projection is unavailable.
Rust has typed phrase encoding and strict telemetry parsing in `training_audio.rs`.

Native fake and muted CoreAudio checks cover all instruments on one stream,
completion, stale/invalid commands, cancellation, mute and physical Park. Existing
native playback/routing and hidden GPUI monitoring checks pass after this change.
Test C4 now invokes native cues, including without a loaded project via an explicit
`--training-only` helper mode. That mode contains no dummy song and acquires output
only when a cue is requested. It rejects song transport operations and requires
zero song duration/position in typed receipts. Test uses production's 2.75 s C4,
32 ms organ attack and 220 ms release, selected instrument and live volume. Its
playing label waits for callback completion plus physical output latency.

Entering Training pauses a loaded song. Leaving, changing the instrument, opening
Settings, changing route or loading a project cancels cues; standalone helpers are
killed/reaped before replacement. An atomic cancellation intent bypasses the
bounded command queue and also rejects late cue preparation. A loaded song stays
paused after leaving. Test does not request microphone capture. The hidden
`test_native_training_ui.py` checks real clicks, no-project completion/reap,
pending navigation cancellation, project replacement and paused loaded playback.
Start opens the native exercise controller described below; completed history and setup persist through the native worker.

The native musical/session domain is implemented in `training_domain.rs` and
`training_session.rs`: all seven selections, every legal octave placement,
harmonic-minor dominant handling, balanced candidate rounds, UTF-16 seeded RNG,
ordered three-attempt interval lessons, source English instructions and guided
reference selection. Session identity uses the shared version-7 canonical config
and UTF-16 FNV128 identity; it is not a native persistence schema. Read-only session
state accepts only validated current-prompt receipts and derives identify answers'
correctness internally. Stale/duplicate results, invalid metrics and response kinds
cannot advance it. This layer performs no PCM processing or DSP. It is connected to Start through
the native controller; on-disk session restoration remains open.
Domain tests include source musical coverage/balancing cases, all keys and
exercise/task combinations, independent Unicode RNG/identity vectors, guided cue
semantics and guarded session transitions. No JS runtime was used for these checks.

`training_scoring.rs`, `training_lock.rs` and `training_capture.rs` now implement
the scalar evidence layer: source duration-weighted windows/median and error
precedence, recent completed-hold scoring, 400 ms median/1500 ms live lock with
drift grace, and harmonic-alias continuity without octave folding. PCM and CREPE
remain in the existing native helper. Rust input telemetry preserves the integer
capture host clock and detector reset count. Training's owner-4 gate rejects
wrong generations/owners, duplicates, stale frames, unknown/regressing clocks,
monitoring input and frames before the response's host-clock boundary.

The default native integration suite passes 138 Rust tests covering pitch-lock/
scoring, controller lifecycle guards and metronome state/storage. One installed-
model test is ignored by default and run explicitly against an existing pack.
`test_native_training_capture.py` drives actual native CREPE with a PCM fixture:
A3 locks after at least 1.5 s (1.52–1.60 s in these runs) and scores on target; that same capture against A2 never
locks and scores wrong octave; Stop is acknowledged. It opens no hardware input.
This fixture evidence does not qualify live singing.

`training_run.rs` now connects Start to native cue scheduling, owner-4 input,
response capture gates, 1500 ms hold/scoring, a 250 ms completed-meter hold,
feedback and summary. References wait for native callback completion plus physical
output latency and the source countdown; later guided references wait a further
150 ms. Capture stays owned between prompts and stops at completed feedback.
Replay restarts the current prompt. Leaving pauses practice and releases audio;
Continue restarts the interrupted prompt. End discards it. Identification does
not open input. Repeated answer clicks cannot overwrite a receipt. Restart creates
a new session. No-project cue replacement retains the helper between guided notes;
explicit cancellation still kills/reaps it. Confirmation tones run through the
same muted native mixer and are rejected while output is parked.

The running and summary surfaces use shared UIKit controls/fonts, including the
bundled Martian Mono 760 face. Summary metrics use source rules: only near-target
notes contribute intonation error; all vocal targets contribute voiced/stable
ratios; skips are excluded from attempts. Native session state stays in memory; validated normalized completion receipts
and setup now persist through the training store below. Training-only sample
recording and native diagnostics are implemented; the recording UI v2 and direct
input v2 checks pass, together with final unit/build/training and strict native
frame regressions. Active-session restoration, remaining setup options and
source animations remain open. Do not treat enabled Start as completion of the full training port.

`test_native_training_run.py` dispatches the real Start/answer/restart/exit controls
in hidden GPUI windows. A real native CREPE PCM replay earns an on-target vocal
receipt and summary; it checks owner release, navigation pause, identification
without capture and guided second-note scheduling after the first hold. Input is
a 220 Hz fixture, with no hardware input and muted output. It captures vocal
states at 1280×800 and identification/guided states at 1060×640. These are partial
state coverage, not a complete visual parity matrix.

The shared-control/font regression batch at
`/tmp/singz-training-running-regression/regression.json` preserves all 18 existing
native screen captures, 17 training route/control captures and all 49 saved-lyrics
paint hashes/glow counters exactly. The normal hidden interaction smoke passes.
Those are native regression checks, not comparisons against Electron. Live FPS,
GPU load and audible training quality remain unqualified by these hidden checks.

SINGZ_GPUI_TRAINING_REVIEW=/tmp/training (with ui-tests/background/mute) runs the
hidden training capture/interaction adapter. Six historical production references
exist at /tmp/singz-gpui-isolated-training-reference. Initial strict comparisons
still differ. Their reference PNGs embed a custom Skia ICC profile whose primaries
do not match the raw sRGB candidate contract; matching source captures are needed
before exact qualification. No reference was converted, stripped or realigned.
Captures and interaction checks are not a parity or audio integration claim. Full required training states and visual comparison remain open.


Training durability (`training_progress.rs`, `training_store.rs`,
`training_program.rs`) now follows production's normalized preference/receipt
contracts without importing its Node implementation. Source-format preferences
(v2, with strict legacy-v1 restoration) and immutable completion receipts (v1)
live in the native app's isolated config directory. Source-compatible receipt
filenames are SHA-256(sessionId).json. Native-only instrument, gain, tolerance,
interval focus and selected-program start time live in `training-controls.json`.
All files are bounded and strictly validated. An existing malformed/future
preference file is reported and preserved. A private, fsynced receipt temp is
hard-linked to its final name: concurrent writers can commit only one receipt,
identical retries deduplicate for the lifetime of the ledger, and conflicting
contents fail. Preference snapshots coalesce and replace atomically. Completion
jobs take priority over queued preferences; a failed preference does not prevent
completion writes. All normal reads/writes run on a native worker. Quit queues
any final-frame UI edit and completed receipt, then joins the worker to flush it.

The filled Progress screen derives lifetime counts, pitch tendency, voiced/stable
ratios, weaker skills and the newest 100 sessions from the full receipt ledger.
Only completed sessions are stored; skips add no attempts, and aborted/paused
sessions create no receipt. No raw microphone frames, observations or PCM are
stored. A store failure stays visible in a shared UIKit banner with an actual
Retry action. Corrupt data must be repaired before it can be replaced.

Selected programs and their original start time survive restart. Lesson progress
uses distinct local calendar days after the program start, matching kind/task
and interval focus. Ordinary lessons require six voiced attempts; interval
imitation requires 18. Repeats, skips, identification and silence cannot inflate
day credit. Yesterday keeps a streak alive until today's practice. Lesson setup
rotates through playable keys without expanding the selected range. The setup
UI now correctly expands each interval set to three generated attempts; source
six-set lessons therefore produce 18 attempts, not six.

`test_native_training_progress.py` first drives the real native cue/CREPE exercise
flow, then launches two fresh processes against the same isolated preferences.
It verifies two durable completed sessions, excludes the partial guided session,
restores setup and program selection, and checks last-frame edits flushed on Quit.
It also injects malformed preferences: existing bytes survive, the actual error
banner appears, and clicking Retry after repair succeeds. Filled progress top and
bottom are captured at both viewport sizes. These are functional/candidate
captures; matching production reference captures and full visual parity remain
open. Unit tests additionally cover concurrent receipt writers/collisions,
completion retry, legacy profiles, shutdown flushing, 105-session lifetime history,
strict normalized metrics, calendar/streak boundaries and program range/key rules.


Song preparation (`training_preparation.rs`, `training_song.rs`) is now connected
to the loaded project. Its Home panel offers Notes, Intervals, Chords and Mixed
warm-up. The recipe preserves the selected vocal range/task, applies the song's
live transpose to a key stamped by key detector version 2 or newer, and does not
mutate saved analysis. The melody detector's version is not key authorization.
Unknown/stale/malformed keys open non-audio setup with a manual-confirmation hint.
Chords restricts mixed prompts to chord-tone/arpeggio; Mixed excludes single-note
imitation. Setup controls follow the concrete recipe kinds. The interval-focus
selector belongs only to the Interval exercise; a focused interval restores its
eligible size list instead of leaving an empty selection.

All native preparation choices open setup before any session/audio/capture is
created. This retains the recorded setup/range-review requirement. The current
Electron checkout's known-key action instead creates a Ready session directly;
that checkout discrepancy remains explicit in the functional parity audit. Native
Start still owns the eventual cue/capture permission. The summary's Back to song
appears only for the same loaded project and returns paused. A new load (including
the same path loaded again) invalidates its context; Save and effect changes keep
that load identity. Project replacement resets Training to Home. Entering Training
queues Pause even if a preceding Play has not yet reached UI telemetry, closing a
pending-Play navigation race found by the real hidden test.

`test_native_training_preparation.py` checks all four recipe controls, setup-first
behavior, stamped minor key + transpose, range preservation, actual prepared-note
CREPE scoring, summary return to a paused song, stale-load invalidation and unknown
key manual setup. Both project files remain byte-identical. Tests are hidden/muted
with isolated preferences and PCM replay, without hardware input. Shared UIKit owns
the preparation panel/buttons and exact 680/780 display faces; all 16 original
faces plus Windows aliases ship in native assets and dist. The prior 14 original
faces remain byte-identical. New recipe captures remain candidate evidence pending
matching production references; audible/hardware singing and live FPS/GPU remain
unqualified. The broader desktop scenario is still in progress.

## Native saved-project deletion

`project_delete.rs`, `project_delete_host.rs`, `project_delete_dialog.rs` and
`integration.rs` connect native catalog directory identity to inspection,
confirmation, worker deletion and host recovery. The dialog uses shared UIKit
controls, initially focuses Keep, and blocks Keep/Confirm/Escape/scrim during an
accepted deletion. This targets saved projects in the currently configured
library; the library root, external/linked directories and changed confirmations
are refused.

The domain snapshots project metadata and bounded tree identities, then acquires
config/library, library-root and project writer leases in that order. The current
configured root is rechecked under the config lease. Accepted deletion first
hides the project under a private `.singz-native-delete-` path, then durably marks
its deleted sync intent before cleanup. Precommit failure/cancellation rolls
back the hide; after that durable commit, completion stays successful even if
later cancellation/cleanup leaves a warning and recovery path. Private staging
is excluded from normal catalog enumeration. The dirty ledger records deletion
intent for the separate native Drive reconciliation worker; its conservative
remote-trash and qualification limits are described in `DRIVE_PORT_REVIEW.md`.

Inspection runs on a separate cancellable worker. Deletion jobs are bounded,
owned and joined at shutdown, so unrelated playback status/Pause remains
responsive during filesystem work. Queue admission precedes loaded-target epoch
revocation. For a loaded target, analysis, beats, lyric envelope/alignment/search
jobs are cancelled/joined, native connection handles are released and telemetry
is cleared before deletion. Failure restores the authoritative original active
path paused via SourceResume, preserving private working-copy target state. Original
folder identity is checked around metadata reads, after native prepare and before
adoption; replacement folders are refused and prepared resources released. Failed
recovery admission clears stale loaded state;
success clears the loaded song and fences old receipts. Deleting an unrelated
project leaves its playing connection and epoch untouched.

Source semantics follow `projects.ts::deleteProject`,
`DropScreen.tsx::confirmDelete` and `App.tsx::handleDeleted`. The confirmation's
open-song note accurately says playback stops/closes rather than repeating the
older conflicting copy. Failure feedback is inline and visible offline, fixing
the source's Drive-configured-only visibility instead of hiding the error.

The current compiled domain/host checkpoint passes 422 Rust tests (0 failed,
2 ignored): `/tmp/singz-project-delete-unit-final-v6.log`. UI v1 found a duplicate-hover
panic, fixed in the shared button. UI v2 verified actual unrelated playback
advancement and metadata-conflict preservation/paused recovery, then exposed a
test-only Songs toggle mistake; the adapter was corrected. UI v3 completed all
1280 scenarios, including writer refusal and loaded-song deletion without
resurrection, but failed at 1060 because the actual native grid had zero height.
The real native catalog section now uses intrinsic sizing/shrink-0, a minimum
68 px grid row and actual outer-page scrolling, making 1060 controls reachable.
The immutable demo fixture branch is unchanged. Final UI v6 passes both sizes with
12 PNGs and four real project deletions in
`/tmp/singz-project-delete-ui-v6-driver.log`. It verifies duplicate Unicode names
with directory identity, a stems-only other project, advancing native status/
position while unrelated deletion is held busy, Keep/Escape/scrim/Tab and busy
guards, metadata conflict with paused recovery, actual writer refusal and loaded
stop/clear with a 350 ms stale-callback check. Python independently checks deleted
folders, untouched library/external sentinels and exact ledger sequence 4 with
four project entries, copied to `durable-deletion-intent.json`.

All 84 raw native full-frame pixel comparisons (18 screen, 17 training, 49 lyrics)
pass. Strict comparison reports, picker/library-import regressions, final unit/normal
build logs and exact source/font recovery identities are retained in the deletion archive. The scripted app workflow supplied
42 app-process CPU samples, median 64.13% and peak 101.25%; this is not an idle
benchmark. Helper CPU is separate, GPU counters are system-wide and hidden live
FPS is unmeasured. See
[project deletion review](PROJECT_DELETE_REVIEW.md). Windows/Linux, matched
production references, live FPS and complete desktop-port qualification remain
open. Training sample recording remains a completed independent checkpoint.

## Training-only recording and retained WAV export

The source `VocalTraining.tsx::TrainingRecording` workflow is implemented in
`training_recording.rs`, `training_recording_host.rs`, `microphone.rs` and
`tools/native/singz-gpui-input.cpp`, with controls in `training_running.rs` and
shared UIKit training controls. It is not a general player/transport recorder and
does not add a custom track. Non-identification training exposes Record/Stop
sample and Save training WAV, with the source active cue/respond/feedback rules.

Recording attaches to the existing generation-fenced owner-4 microphone. The
helper reuses `zcore/audio/capture_recording.h::CaptureRecording`, consuming raw
mono input before CREPE, retaining the native sample rate and limiting the take
to 30 seconds of PCM16. No PCM crosses into Rust and no new capture owner or DSP
path is created. A private take is validated and published under the native
config's `training-recordings` directory. Capture stop, navigation and shutdown
finish owned takes; recoverable publication failures retain their audio.

Monotonic take IDs identify requests independently of microphone generations.
Changing recording context permanently detaches its pending receipt, so a rapid
same-practice A→None→A navigation cannot reattach old Started/Finished/errors.
Header navigation detaches immediately rather than relying only on the polling
loop. Delayed accepted exports still fulfil their chosen file operation while
old failures are fenced from unrelated recording controls.

`training_recording_store.rs` provides a bounded worker queue for retained WAV
exports. It validates trusted-root membership, ordinary-file identity, RIFF
structure, nonempty mono PCM16 at 8–192 kHz and the 30-second bound. Exclusive
staging, source integrity revalidation, no-replace publication and guarded approved
overwrite preserve the retained original and refuse changed/linked destinations.
Cancelled or failed exports leave the original intact. Export does not mutate
project metadata or the pending-sync ledger; exporting a recording does not
schedule a project upload.

The checkpoint passes 390 normal Rust tests (0 failed, 2 ignored), including
recording ownership/attachment and 18 storage tests:
`/tmp/singz-training-recording-unit-final.log`. Native helper compilation passes in
`/tmp/singz-training-recording-native-build.log`. UI-feature build v2 and the
actual hidden/muted driver pass in `/tmp/singz-training-recording-ui-v2`, with
12 PNGs and 6 WAVs across both desktop sizes. Native Tab/Space/Enter dispatches
recording exactly once without reaching global Play; guidance, recording dock
and left status no longer overlap. V1 passed interactions but visual review
found overlap, corrected using source compact-height rules below 680 px and
normal metrics; both v2 sizes were inspected. Direct native input v2 passes an
actual raw 8 kHz PCM oracle before CREPE, the exact 30-second cap while capture
continues, and generation/ID/duplicate/monitor/symlink/existing/empty/stop faults.
Prior input, microphone and monitor regressions pass. The final unit suite (390 passed, 0 failed, 2 ignored), normal build and
training-run regression pass, as do 8 comparator self-checks. All 84 full native
baseline frames match strictly in
`/tmp/singz-training-recording-regression-v2/strict-comparison.json`. Initial
training Home differences were hover borders only (6,110/7,140 pixels); the
app-local pointer was moved outside before final Home captures and immutable
baselines were rerun, yielding 84/84 exact. Final UI v3 changes only that test
adapter settlement; recording production code is unchanged from UI v2. The test Save-path interception
reaches the same acceptance method and actual export worker; OS chooser
presentation remains unqualified. Actual hardware input, permission UI,
native chooser presentation, Windows/Linux execution and production-matched
visual/temporal parity remain unqualified. See
[training recording review](TRAINING_RECORDING_REVIEW.md) and the
[completed functional checkpoint archive](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-training-recording-20261107/REVIEW.md).
The UI process supplied 56 CPU samples, median 1.52% and peak 86.08%; native
helper CPU is separate, GPU telemetry is system-wide and hidden live FPS is
unmeasured. The full desktop goal remains incomplete.

## Native diagnostic sessions

`diagnostics.rs` and `diagnostics_host.rs` now back the native Log dialog with a
bounded in-memory ring and a dedicated filesystem worker. Normal native startup
installs a shared sink before other workers start; shutdown stops those workers
first, records the stop event and flushes the log last. Real project open/save/
split lifecycle events, separation stages, resolved engine commands/provider
failures and bounded streamed stderr are recorded; progress spam, NUL bytes and
ANSI color escapes are filtered. Demo/review fixtures remain separate and
immutable.

The source contract retains the latest 4,000 live entries, levels and millisecond
timestamps, truncating each message at 2,000 JavaScript UTF-16 units. Copy formats
the displayed rows in local time; durable/exported text uses the source ISO UTC
line format and `SingZ <version> — <platform>-<arch>` header. The native config's
`logs` directory retains the current launch and ten previous ordinary sessions.
Info lines flush after 500 ms without extending the first pending deadline;
warnings/errors and shutdown flush promptly. At the 8 MiB session cap, one source
warning replaces the pending disk batch and further entries remain live-only.
The bounded disk queue reports pressure drops explicitly while the live ring
still retains the latest entries. Unwritable disk state is exposed without
failing playback.

Past reads parse structured lines and preserve unstructured/partial lines as raw
rows. Only the last 4,000 rows are mounted; the full parsed total remains available.
Current Save exports the live ring after destination acceptance; past Save exports
the full selected session, rather than only its displayed tail. Request IDs,
modal sessions and selection generations reject stale reads and stale Save UI
receipts. Closing the panel cancels pending reads/list requests, while accepted
exports still complete without reviving a dismissed panel.

The worker validates session names and bounded ordinary files, refuses session
links and oversized reads, and preserves foreign or oversized files during
rotation. Exports stage beside the exact chosen destination, reject links and
unapproved overwrite, check an approved existing destination for changes and
publish without arbitrary deletion. Existing retained session files cannot be
replaced through export. Native Save dialog selection is wired, but actual dialog
presentation/overwrite confirmation is not verified by hidden path interception.

The checkpoint in `/tmp/singz-diagnostics-unit-final.log` passes 359 Rust tests with
zero failures and two explicitly ignored real-engine cases. New tests cover
rotation/restart, ring/tail/full export, UTF-16/time formats, cap/flush behavior,
queue pressure, cancellation and destination safety. Actual subprocess regressions
also cover direct-child exit with inherited pipes, bounded timeout/cancellation
and complete delayed output; Unix cleanup kills the owned process group. Windows
reader cancellation has native readiness polling, but Windows descendant-tree
cleanup is not qualified.

The final hidden/muted diagnostics UI v6 driver passes
(`/tmp/singz-diagnostics-ui-v6-driver.log`), with 32 candidate PNGs in
`/tmp/singz-diagnostics-ui-v6` across seed/review/short launches at both desktop
sizes. It covers the long Cyrillic/emoji UTF-16 split row, intrinsic body sizing,
4,000-row history returning to a short current session, shrinking content,
session-popup inventory cleared on reopen, Copy acknowledgement reset and
clipboard restoration, follow-scroll, full past-session Save and Save race fences.
The model-manager and source-workflow regressions also pass, recorded in
`/tmp/singz-diagnostics-models-regression-driver.log` and
`/tmp/singz-diagnostics-source-regression-driver.log`. The
engine-setup and sidebar regressions also pass. The normal build passes in
`/tmp/singz-diagnostics-normal-build.log`; 84/84 strict native full frames match
the engine-setup baseline and 6/6 historical native Log fixtures remain identical.
See the [completed diagnostics review](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-diagnostics-20261107/REVIEW.md). These are connected workflow checks,
not certification of actual native chooser presentation, Windows descendant
cleanup, matched production visuals or live display performance. Earlier
production/native Log frame differences and missing temporal, locale,
accessibility and platform qualification remain open.

## Native model manager and separation

The native AI model manager (`models.rs`, `model_catalog.rs`, `model_service.rs`,
`model_install.rs`) now follows the production `SetupWizard`: platform-filtered
required/optional entries, shared model caches, missing-part download sizes,
Get/Reinstall, progress, explicit-target retry, installed badges and Windows
GPU/CPU preference. The header opens this persistent modal. Visible native launches
offer missing required models automatically; hidden tests never start unsolicited
downloads. Manual Close cancels; automatic Skip leaves the worker running. A
completed automatic wizard closes after 1.1 seconds. Escape and scrim clicks do
not dismiss it. Shared row/progress controls live in native UIKit.

The model installer invokes system curl/tar directly, without a shell, Node, Electron
or execution of downloaded code. The splitter URL stays pinned to the app release. Downloads
are cancellable, bounded and validated; splitter archives require the source
platform pack format and expected files. Multipart replacements stage all parts
before publishing. An fsynced transaction journal restores an interrupted partial
publication; OS cache locks serialize native installers. Failed replacements
preserve working files. Ordinary cancellation and shutdown reap owned processes
and clean their staged files. A hard process kill before journal publication can
leave uniquely named staging files; automatic scavenging of those files is not
implemented. Existing production-app staging files are never deleted.

`test_native_models.py` uses an isolated loopback HTTP server and deliberately tiny
non-executable model/archive fixtures through the actual hidden GUI and curl/tar
worker. It tests persistent dismissal, manual cancellation, automatic Skip,
obsolete-pack rejection, explicit-target retry, partial multipart downloads,
truncated multipart rollback, CPU changes during downloads, installed status,
shutdown cleanup and restart. The Windows catalog is simulated on the host;
this does not qualify Windows execution. Production remote release installation and matching production reference captures
remain unqualified. Runtime readiness is established separately by a real
interpreter/module probe; installed files alone are insufficient. No destructive
cleanup of obsolete model families has been added.

`source_jobs.rs` connects loose audio and all three production split modes:
instrument stems, lead/backing only, and the combined request. It reuses the
resolved system Demucs command or installed interpreter and existing inference implementation. The ONNX runner is
now the single `scripts/onnx_split_runner.py`, imported as raw text by the older
desktop and embedded by Rust. Its extracted bytes match the previous TypeScript
template's runtime bytes. The existing vocal runner remains shared unchanged.
Apple Silicon GPUI can also probe/use an installed Intel macOS ONNX pack from
the shared cache; the interpreter is an independent process. Windows retains the
RTX-to-CPU ladder and source watchdog deadlines, pending execution qualification.
System Demucs discovery is implemented; Linux inference installation and execution
qualification remain open.

`engine_status.rs` follows production system-first discovery: `SINGZ_DEMUCS`,
Demucs in the expanded GUI PATH and known local bins, then Python module launchers,
unless `SINGZ_NO_SYSTEM_ENGINES` disables system candidates. Each real `--help`
probe is cancellable and bounded; a validated installed Torch/ONNX pack is the
fallback. Readiness records the resolved execution command, and every Split
rediscovers before using that actual command. System Demucs handles instrument
stems; lead/backing and combined requests still require the installed UVR pack.
Files alone never imply executable readiness.

The native legacy instructions dialog (`engine_setup.rs`, `engine_setup_host.rs`)
ports the source install command, selectable/copyable command text, GitHub link,
Recheck, keyboard focus and dismissal. Its header route is conditional: failed
status without `needsModels` opens instructions; ordinary exhausted discovery
always reports `needsModels: true` and opens the model manager instead. Recheck
uses a separate native worker, so it cannot cancel active Split/Open/Save jobs.
Generation/session fences reject superseded receipts; monotonic probe-start
stamps fence source-worker and independent-checker readiness updates. Closing
instructions leaves an accepted check running without allowing its receipt to
reopen a dismissed instance. Shutdown cancels and reaps both workers.

The final engine integration checkpoint passes 338 Rust tests, including actual
fake-engine subprocess discovery, cancellation/timeout, pack validation and a
resolved system-command stem execution. Final hidden engine-setup UI v4 passes
both stale-probe orders, native selection/copy and actual failed-startup recovery.
Existing model-manager, source and lyrics workflows pass; all 84 native regression
frames and 49 glyph regions remain exact. Evidence is archived in
`gpui-engine-setup-20261107/REVIEW.md` under the session visualization directory.
These receipts do not qualify real system Demucs inference quality, matched production
visuals or Windows/Linux execution.

The existing C++ bridge has offline `--render-input` and `--compact-stem` modes.
They use the shared native decoder/resampler and verified FLAC compactor without
constructing an audio host. Pack input becomes 44.1 kHz stereo PCM16 for the splitter; system Demucs receives
the original audio in the private project copy.
Native decoder limits and enabled codecs still apply. Only ordinary private
copies enter inference; cancellation, new opens and shutdown revoke job ownership
and reap owned subprocesses. Working results stay outside the song library until
explicit Save. New names use collision suffixes. Re-splits preserve their original
destination, and external metadata changes refuse publication. Project-relative
lead/backing metadata adds the seventh lane to decoding, mixer controls, peaks
and persistence. Arbitrary custom tracks are connected as described below; saved native graph playback is connected in the [graph checkpoint](NATIVE_GRAPH_REVIEW.md).

Publishing a re-split stages generated audio and metadata together under the
destination's native write lease. Its journal restores interrupted partial
publication and retains backups when recovery itself is refused. Linked staging
members and foreign paths are rejected. Unrelated project files and unknown
metadata survive. Instrument PCM16 stems compact through native libFLAC; float
vocal residuals stay WAV. Unconvertible stems retain WAV with a v1 retry marker.
Cache/project publication leases explicitly unlock before closing, preventing a
forked child reference from briefly retaining ownership after the parent drops it.
An independent duplicated-descriptor test pins that behavior. Successful working
copies are retained in `source-work`; cache scavenging, discard confirmation and
working-copy recovery UI remain open.

`test_native_source.py` drives actual hidden GPUI file-drop and Split actions,
Cancel, Save, playback and reopen. It checks seven-lane mixer persistence, the
backing-only path from an existing FLAC project, native PCM preparation and FLAC
compaction, missing stems, cancellation, changed-audio Save conflicts, unrelated
metadata/files and shutdown descendant cleanup. `--real` runs the same path with
the installed ONNX and UVR weights, without downloads; the 2-second synthetic
input qualifies pipeline integration, not separation quality on music. Both modes
passed on this Mac. Real Apple Silicon Torch, Windows/Linux, source-format coverage,
long songs and audible output remain unqualified. CPU/footprint samples are for
the main GPUI process; GPU counters are system-wide. Separate inference CPU and
live display FPS are explicitly unmeasured. New progress/menu captures remain
candidates pending matched production references; progress easing and exact
loading layout remain open. Split jobs now use a shared UIKit amber footer status
pill with percent, a cancel button and a 1.6-second shimmer. The current graph
keeps playing and accepts seek, mixer and transport changes during inference.
The result handoff restores position, playing state and the latest transport
settings. Backing-only preserves existing lane mix; re-split standard lanes are
fresh, with an existing custom backing lane retained, matching production lane
replacement semantics. Import and Save remain blocking operations. Matched
production captures are still required: the native shimmer uses a horizontal
sweep while the source gradient is 100 degrees, and cancel settlement/phase
loading labels need further parity review. Hidden interaction tests cover the
inline footer at both sizes and playback/transport handoff.


Title editing (`header.rs`, shared UIKit `title_input`, `project_rename.rs`) is
connected to the pencil instead of Save. Enter and outside click commit a
trimmed nonempty value; Escape cancels. Native outside-click handling supplies
the browser blur behavior for nonfocusable waveform targets. Closing the editor
restores player keyboard focus only if another input has not taken focus.
Loose, unsaved-source names stay in memory until Save.

Saved project renaming keeps the current parent and uses the source safe-name
rules. The backend revokes the previous load epoch before joining analysis,
releases native media handles, takes the same metadata/publication lease, checks
the expected metadata fingerprint and uses an exclusive native directory move.
Even an empty sibling is never replaced. Metadata publishes atomically; a
publication failure attempts an exclusive rollback. If rollback is obstructed,
the real moved path and a warning survive, so the UI cannot keep writing to an
obsolete identity. A crash between the directory move and metadata publication
can leave the old title inside the moved folder; audio and project metadata
remain present, but a durable rename journal is not implemented.

The reopen handoff preserves current mixer/transport, paused position and playing
state. A saved song with unsaved split results keeps that private audio: renaming
moves/reanchors its saved destination and fingerprint, then Save publishes the
working results there. This path does not reopen saved audio in place of the
working copy. Unknown metadata, unrelated files and media bytes are retained.

`test_native_title.py` checks native pencil/input interactions, Escape/blank/Enter,
outside click, paused seek receipts, playing rename, collision/external-edit
refusal, dirty mix, loose-source naming and explicit Save. Source fault coverage
also includes renaming an unsaved split with an existing saved destination.
Filesystem units inject metadata and rollback failures. New editor captures are
candidates, not a production parity claim. Production success notices, tight
header geometry and Windows/Linux execution still need qualification; the
1060px capture exposes the narrow title allocation rather than certifying an
accessible compact editor. Same-song rename/split reopen now retains the current screen and leaves library
search or modal input focus intact; explicit opening of another project still
selects the player. The hidden title flow keeps library search focused through
rename, and the controlled split flow leaves Settings open through completion
(with microphone capture disabled for this navigation fixture). Other concurrent
route/owner combinations and modal-backdrop freshness remain unqualified. CPU/footprint samples cover the GPUI process and GPU
counters are system-wide; hidden live FPS remains unmeasured.


Quick start (`quick_start.rs`, `guide_layout.rs`, shared UIKit `guide.rs`) now
connects the header Help and Settings entry points. First-run welcome waits for
model setup and other blocking surfaces to clear; dismissal is atomically stored
in the native configuration directory. Manual replay remains available after
restart. Candidate steps are frozen when opened and filtered to measured controls:
four in Library and eight in the default lyrics-enabled Player. No missing Sync
control is invented. The welcome and desktop copy come from production source;
`gen-gpui-quick-start.py --check` verifies the embedded English snapshot without Node.

UIKit owns measured border-box anchors, the rounded cutout, outline/arrow, balloon
and primary/ghost buttons. Placement ports the shared source rules and scrolls
Library targets into view. The tour blocks workspace clicks even through its hole,
traps Tab/Shift-Tab, supports Enter/Space and Escape, and focuses the heading on
each step. GPUI key bindings resolve Tab before ordinary key handlers, so the tour
uses its own scoped actions rather than relying on a key-down handler alone.

`test_native_quick_start.py` captures 30 states at 1280×800 and 1060×640 plus
two diagnostic underlays. It exercises welcome gating, actual focus handles, Back
by mouse and keyboard, all available steps, Help/Settings entry, Escape, durable
dismissal and manual replay in a second process. An exact pixel check toggles only
the shade and retains the balloon/shadow in both frames to establish that the
cutout does not darken the highlighted control. Removing the entire overlay would
confound this check with the balloon's intentional shadow. CPU/footprint samples
cover GPUI and GPU samples are system-wide; hidden live FPS is unmeasured.

New tour captures remain candidates without matched production references. Hover
styles are immediate; source CSS transitions are not reproduced. Russian/global
locale support, native accessibility dialog semantics, exact focus return to the
invoking control and foreground first-run/platform qualification remain open. The
version badge still shares Help routing rather than implementing release highlights.
The underlying compact player header remains clipped; tour geometry does not
qualify or fix that pre-existing layout. The complete desktop port remains active.

The metronome is now connected to the native player. `metronome.rs` composes
shared UIKit rows, segmented controls, chips, tempo input and loudness control;
`beat_grid.rs` caches timeline marks and shaped bar labels. The popover supports
click/count-in, accent, loudness, grid visibility, typed/tapped tempo, half/double
time, meter, bar rotation and 10 ms nudges. Enter/blur commits the tempo draft;
Escape cancels it. Popover input is occluded from the underlying waveform, and
hidden checks assert unchanged paused position and seek count while using controls.

`beat.rs` ports source scalar/grid sanitization, constant/tap tempo, bar numbering,
accents and tempo/meter edits. Its manual-bar domain preserves the immutable
underlying detector grid, provenance and correction fields when folding, moving or
clearing hand-placed bars. Pointer handles and automatic detector integration are
connected through native ruler controls and a cancellable analysis worker. The
ruler handles preview a snapped drag without changing accepted audio, commit on
release, and Alt-click clears a hand correction. Hand edits retain the detector
base and save after the audio receipt. Rust emits bounded 96-member chunks with
the source bridge's 20,000-beat and 40,000-event limits. A requested click without a grid remains a
saved intent; effective song clicks require a grid, while gridless count-in works.

The private helper protocol is:

- `met-begin click countInBars volume accent beatsPerBar downbeat beatCount barCount`
- `met-beats offset count seconds...` and `met-bars offset count beatIndexes...`
- `met-apply` publishes the validated candidate; `met-preview 0|1` auditions the
  ordinary/accent click through the existing reference bus.
- `play-flat` resumes an internal same-song audio handoff without another count-in.

Every line remains below 4096 bytes. Chunks arrive in order with at most 96 values
per message. The backend owns each complete upload as one serialized request with
project-epoch and receipt-serial guards. Partial, malformed, oversized or
planner-refused uploads retain the active graph; malformed chunks retire their
draft. A new begin replaces a draft. A successful receipt remains authoritative
even if a newer optimistic update is subsequently rejected. Audio transport
uncertainty retires the helper rather than pretending a rejected state is active.
The shared C++ `PlaybackCuePlan` owns event timing/PCM and the native session owns
output; Rust does not duplicate DSP, timers or click waveforms.

Live plan changes reuse the tempo/transpose graph-swap path and preserve the
stream, mix, loop and transport. Explicit Play with count-in rebuilds the paused
plan at the audible original-song anchor. Gridless count-in uses three one-second
ticks per selected bar. Count-in participates in playing intent, with separate
`countingIn` status and negative rendered frames. The player holds the displayed
song position at its anchor until the count-in lands. Countdown dots are still
missing. Route changes/unpark restore the plan paused without replaying count-in.
Accepted song starts are tracked separately from callback activity: preview can
run callbacks with transport still Stopped, and telemetry can lag an accepted
paused Start. Same-song source handoff uses `play-flat` to avoid restarting the
count-in. Source completion and conflicting edits wait for pending metronome
receipts/count-in rather than consuming an update prematurely.

Saved projects restore metronome settings and beat grids. `project_store.rs`
merges owned fields while retaining unknown metadata; clearing an accepted valid
grid removes its old saved field. Save waits for accepted audio state, and queued
navigation waits for that Save. `metronome_store.rs` retains app-wide preferences
atomically under a lease, preserving unknown fields and refusing corrupt/future
versions. Global grid visibility survives song opens; a legacy song without saved
metronome settings inherits current accepted preferences. Visible project adoption
is queued explicitly, and shutdown drains adopted preferences without dispatching
queued audio work. Preference-write failures are reported separately from accepted
audio changes.

`beat_analysis.rs` reuses the installed `singz-analyze` detector and Beat This
pack without Node. A missing grid or older automatic stamp starts detection;
manual and newer stamped grids are preserved. The popover's Re-detect explicitly
re-reads the available drums. Before both native detection and the neural mix,
`singz-gpui-audio --measure-input <file>` measures guitar/piano through the shared
native decoder; only those two lanes are filtered at whole-lane RMS 0.004. The
measurement includes every channel, so anti-phase stereo is not mistaken for
silence. Mixer gain, mute and solo do not alter detector inputs.

The installed model path renders `mlmix` through the existing core resampler,
runs the pack's offline Python beat runner, then passes its lattice and lyric
line/word timings to `analyze --beats --ml-stdin` through a private token file.
The phases have separate 120/180/180-second bounds; stdout and NDJSON records are
bounded. Missing or failed ML produces an explicit diagnostic before the native
fallback. The shared mix requires 44.1 kHz inputs; unsupported rates are diagnosed
rather than passed through a different resampler. Model capability checks include
the actual interpreter, runner, format and weights, including ONNX logmel.

The backend runs this work off the audio command thread. Cancellation, project
epoch, detection serial and manual mutation guards fence results; input paths and
loaded length/modified stamps are checked at capture and again after execution.
Task-owned child groups are stopped/reaped and private files cleaned on all paths.
Successful detection waits for pending metronome receipts, folds the current
user-bar corrections onto its new automatic base, then sends one serialized audio
update. Automatic detection and bar edits save after acceptance; explicit
Re-detect marks settings changed for Save. Working-copy automatic changes remain
private until an explicit Save publishes the project. A musical refusal retains the old grid;
explicit Re-detect reports that no steady beat was found. Detector errors remain
distinct. Progress uses the shared native analysis note. Pitch and beat requests
are currently separate processes, so source's combined decode/analysis optimization
and detailed model-progress streaming remain open.

The shared engine's legacy master remains a song-bus gain. An additive reference
gain override and atomic paired song/reference update let the app combine its
master with click loudness without changing that core contract. Helper rebuilds,
route changes and monitoring unpark retain the coordinated gain. `SINGZ_MUTE`
explicitly zeros the cue plan and both bus gains while preserving requested
preferences. The initial fake-host regression caught a reference-bus leak before
any hardware test ran; the current muted checks assert silent output.

Verification covers 138 Rust tests, with one installed-model test ignored by
default, and the shared native playback suite;
`test_native_metronome.py` checks staging, active-graph isolation, full-size limits,
preview, stream swaps, mid-song/variable-meter/gridless count-in, tempo/route/loop
retention and monitoring park guards. The combined playback/metronome/training
checks pass in eight fake-output and forced-silent hardware runs.
`test_native_metronome_gain.py` checks scheduled and preview click gain ratios,
master zero, rejected updates and rate/route/park retention with an unconditionally
fake host; it never opens hardware unmuted.

`test_native_metronome_ui.py` uses hidden muted windows. Initial, grid, edited
and BPM-draft controls run at both desktop sizes, including receipts, tempo
commit/cancel and invalid input, grid paint and paused-position/seek invariance.
The hidden checks also exercise bar-handle geometry, snapped drag preview,
release, Alt-clear, Save/reopen and preserved detector/foreign metadata at both
sizes.
The 1060-wide flow additionally checks a superseded success followed by rejection,
same-song handoff, deferred Save/navigation, Save/reopen, unknown metadata,
count-in anchor and gridless/tap behavior. A fresh process checks global preference
restoration over the song's saved grid preference, legacy-song inheritance and
preference adoption on immediate quit. The specifically combined
working-copy Save/navigation path and all preference-error UI states remain
unqualified beyond the covered unit/interaction paths.

The opt-in `beat_analysis::tests::installed_runner_real` separately passed against
the actual installed ONNX Beat This pack and native analyzer: a 32-second
percussion fixture yielded 65 beats at 120 BPM with ML used, no fallback warnings
and unchanged input stamps. It writes tool/model/input hashes and the resulting
grid; this is a real pipeline check, not general musical-quality qualification.
`test_native_beat_detection.py` drives the connected app state with a deliberately
stubbed analyzer for deterministic asynchronous faults. Its final hidden run
passes missing/stale automatic detection and Save, protected manual/newer grids,
actual Re-detect activation with live user bars, rapid requested-grid/Accent
updates, automatic-Save conflict/navigation ordering, changed-input refusal,
navigation/manual-intent cancellation, rejected-grid nonpublication and not-found
retention. The rejection case exercises Rust command admission, not an injected
native planner failure. The same harness verifies real helper RMS against
anti-phase stereo without opening an output stream. A chained second automatic
Save guard has code review but no separately forced end-to-end case. These state
checks do not establish detector quality or production visual parity.

The existing native regression comparison remains exact for 18 screen captures,
17 training captures and 49 full lyric frames, separately from the approved lyric
paint-region checks. These immutable native baselines do not establish production
Electron parity. New metronome captures remain candidates without matched
production references. CPU/footprint samples cover the GPUI process, excluding its
helper; GPU samples are system-wide. Hidden live FPS is unmeasured.
Countdown dots, the live player BPM field, source transitions, locale, full keyboard/accessibility parity,
audible musical quality and Windows/Linux qualification remain open. No Node,
foreground activation or global input is used by these checks. The desktop port
is not complete.

## Native lyrics sidebar, lookup and publication

The sidebar now uses `lyrics_sidebar.rs` and shared UIKit controls instead of
placeholder actions. `audio_tags.rs` reads original-file tags in Rust;
`lrclib.rs` applies the source tag repair, placeholder-artist filtering, filename
cleanup and artist/title retry ladder. Its native curl transport serializes
requests, bounds response size/time, separates a confirmed miss from service
failure, and retains endpoint cooldowns and global Retry-After deadlines.
Manual search ranks synced records first and then by duration, caps the picker
at fifteen entries, and refuses applying text-only entries. Candidate selection
publishes its synced LRC immediately. Parsing preserves source timestamp, empty
gap, repeated-stamp, UTF-16 word-weight and millisecond-rounding behavior.

`lyrics_resolution.rs` retains the source distinction between cached LRCLIB,
edited and transcribed lyrics. Edited words remain sticky; cached transcription
can retry the current LRCLIB ladder without declaring an unanswered lookup a
permanent miss. LRCLIB/edited sources expose Check & align and capability-gated
Precise, while the transcribed source retains Edit and Change…. Source/credit,
alignment/check feedback, inline version search, empty results, progress,
consent/download, retry and cancellation are connected to project-scoped host
state. Actual Qwen transcription and alignment use installed native engines;
Precise uses the existing pack's Python/MMS path. Model acquisition requires an
explicit consent action. A mismatch reports its check while keeping the saved
lyrics unchanged. Sidebar alignment publishes an accepted result directly;
the separate editor's alignment remains a draft until Save.

`publish_resolved_lyrics` validates and prepares glyph masks before publication,
then uses the project writer lease and captured expected-present/expected-absent
lyrics identity for atomic replacement. Epoch/serial fences reject another
song's result. Cancellation before commit leaves lyrics alone; once a commit
has completed, its receipt still updates the accepted identity before deferred
Edit, replacement, working-copy Save or split handoff proceeds. Queued editor
opening participates in those holds. Invalid or oversized lyrics metadata is a
lyrics error, rather than a reason to discard otherwise playable song audio.

Editor opening snapshots the displayed lines and only the ready sidebar's
credit. Save uses that explicit snapshot: omitted credit is removed, supplied
credit is retained, and the known `aligned`, `check`, `base`, `engine`,
`lrclibPending` and `lookup` derivatives are cleared. Unrelated future fields
remain intact. This prevents a later Check & align from using an old base after
the singer has changed words or timing.

`sync_dirty.rs` records durable local sync intent after successful lyrics
publication. The native config directory's standalone `sync.json` preserves
unknown root and dirty-state fields and uses a shared file lease, bounded JSON,
captured-byte conflict checks and atomic replacement. Per-project sequence
marks retain the first dirty timestamp; beyond one hundred distinct projects,
the ledger marks the whole library. Clearing a captured high-water sequence
retains newer in-flight marks and never resets the sequence. File marks ignore
lyrics without a surrounding project. A failed ledger write is reported as a
warning after local lyrics have already been saved. The ledger stores intent;
the separate native Drive service now provides the account, reconciliation and
scheduler described in `DRIVE_PORT_REVIEW.md`.

The archived `gpui-lyrics-sidebar-20261107/sidebar/result.json` records passing hidden,
muted checks at two desktop sizes: real input/Enter search, empty results,
text-only refusal, candidate application, conditional source actions, speech and
Precise consent, deterministic inference progress/cancel, mismatch no-write,
stale HTTP rejection, external conflicts, postcommit cancellation/queued Edit,
editor Save after a committed cancel, working-copy Save coordination and
oversized-lyrics playback. Its inference processes and model headers are
controlled protocol fixtures; these checks do not establish neural quality or
live LRCLIB availability. Reproduce after the native helper and `ui-tests` app
builds with:

```sh
python3 experiments/gpui-player/tests/test_native_lyrics_sidebar.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-lyrics-sidebar
```

The separate `/tmp/singz-sidebar-real-qwen/lyrics-alignment-real-receipt.json`
records actual Qwen cold/warm alignment and transcription on a private roughly
nine-second offline speech fixture. Both alignment checks matched all fixture
words, the heard-word cache used source format, and no `lyrics.json` was written.
This is limited pipeline evidence, not general singing-quality qualification.
Actual Precise execution remains blocked by unavailable installed MMS weights.
Final hidden sidebar/editor, alignment, source, import and picker workflow suites
pass. The same-cycle Cancel regression keeps Ready visible after late progress
while retaining final-result ownership. Demo/training frames are 35/35 exact and
comparable native glyph regions are 49/49 exact; all full-frame differences are
confined to the source/action row. Evidence: `gpui-lyrics-sidebar-20261107/REVIEW.md`
in the session visualization directory. New sidebar
screenshots remain candidates without matched production references; temporal
parity, locale/accessibility and Windows/Linux sidebar qualification are open.
Hidden stepped captures do not establish live FPS or display smoothness.

## Arbitrary custom tracks

The native player loads portable saved custom metadata and supports Add/Rename/Remove
with stable IDs, typed picked paths and a sixteen-active-lane native limit. Built-in
role addresses remain separate from custom identity. A bounded native decoder worker
accepts valid picks around damaged files before allocating ID/slot/color. Replacements
preserve accepted ID mix and transport; refusal, lost connection and irreversible graph
commit failures have distinct truthful outcomes. Original encoded bytes are transactionally
published with metadata on Save; only unused ordinary custom-prefixed files are pruned.
Owned reopen overlays preserve unsaved custom additions/removals and ID-based mix through
rename/import/source handoffs, and source jobs retain customs across Save and re-split.
Vocal coverage is validated against native vocal duration independently of the longer
timeline; beat inputs retain only built-in roles with strict path/stamp checks.

The core checkpoint passes 475 Rust tests (two ignored), real native helper/DSP tests,
a final hidden two-size workflow with mixed-file Add, actual custom and project rename,
unsaved Add/Remove handoffs, Save/reopen, independent WAV/FLAC hashes, loop bounds and
keyboard focus restoration. Existing title/import/deletion regressions pass; 84 full
native frames are strictly unchanged. See [the review](CUSTOM_TRACK_REVIEW.md).

Final-lane removal now releases the native graph and persists an explicit empty document.
Hidden real Copy/Move cases cover empty and unsaved custom-bearing imports. See
[the empty-project review](EMPTY_PROJECT_REVIEW.md). Full inference re-split E2E,
all codecs/long songs, native chooser presentation,
production visual/temporal references, locale/accessibility and Windows/Linux still
need broader qualification; unit filesystem/handoff checks do not certify those scopes.
Account/sync remains separate required desktop work. Source-track export is now connected below.

## Empty custom-only documents

Removing the final custom lane commits a native Release and leaves a loaded project
with zero duration, position and lanes, rather than closing it or creating silent PCM.
The helper reports an explicit empty state, actual graph generation zero, monotonic
lane-set revision and a validated cleanup proof. Root admits telemetry only for the
accepted lane revision and document intent; delayed same-epoch song statuses cannot
resurrect removed audio. Uncertain native commits retain a dirty recoverable document
and block audio actions without inventing release proof.

Save writes strict `nativeEmptyTracks: true`, `nativeOriginalDisabled: true` and an
explicit empty custom array, omitting timeline ranges. Existing source files are not
rediscovered as audio. Unknown metadata and unrelated files survive; pruning remains
scoped to unused ordinary custom files. Library discovery, Copy/Move import and typed
unsaved overlays preserve this intent. A new valid Add creates paused native audio;
failed Add preserves the empty document. Clips shorter than two seconds can zoom
without invalid clamp bounds.

Logical output, volume, tempo and transpose remain available. Song transport, split,
metronome and editing actions require audio; shared UIKit supplies disabled styling.
Standalone training can temporarily own output while the song graph stays empty,
then returns to proven release. An unavailable selected output remains selected;
fresh Add refuses that route rather than choosing the system default.

The checkpoint has 507 passing Rust tests (two ignored), real native helper lifecycle
and disconnected-route tests, and three independent hidden UI launches at both sizes
covering Remove/Save conflicts, restart, Copy/Move, training, invalid Add, short-track
zoom and fresh paused re-add. See [review](EMPTY_PROJECT_REVIEW.md) for exact evidence
and the remaining full desktop qualifications.

## Native source-track export

The ruler export arrow opens the production source-backed shared UIKit dialog.
Defaults are MP3, Separate stems and every source selected. Karaoke includes only
instrument roles and generated backing-vocal IDs, excluding lead vocals, original
full mixes and arbitrary custom tracks. Export snapshots typed paths before the
native folder chooser; modal sessions and actual worker job IDs fence delayed
chooser/terminal receipts. Busy Cancel waits for the owned worker to finish cleanup.

A dedicated Rust worker runs sources sequentially through `singz-gpui-audio
--export-audio`. This offline command calls existing zcore `exportAudio`/`exportAudioMix`,
never constructing an audio host. WAV/FLAC are 16-bit; MP3 uses the source encoder
contract. Original source audio is independent of current mixer, loop, tempo and
transpose. Only exact built-in missing WAV paths can resolve to compacted FLAC.
Sources are ordinary pinned files; changed identity/stamps refuse publication.
Private staging, bounded receipts, cooperative native cancellation and a final
publication decision fence protect output. Exclusive atomic publication never
replaces existing files, while prior completed outputs survive later errors/cancel.
No project metadata or sync-intent mutation belongs to export.

527 Rust tests pass (two ignored), including twenty export domain/worker cases and
cancellation at the final publication boundary. Actual native codec/mix/limiter
and in-flight cancellation checks pass. Final hidden two-size UI v4 passes twenty
captures and independent spectral checks of thirty-eight encoded outputs, with
source metadata/files preserved. See [stem export review](STEM_EXPORT_REVIEW.md)
for evidence and remaining production/chooser/hardware/platform qualifications.

## Carry the line

`carry_line.rs`, `carry_line_host.rs` and `carry_line_popover.rs` connect source
TrainPopover semantics to the existing native training duck scheduler. Complete
helper drafts are validated before candidate graph publication. Carry revisions
fence playback status; accepted receipts alone update configuration and cached
lyric turn masks. Native failure retains the document paused, with explicit reopen
feedback. Save/Open ordering shares the working-copy publication lifecycle.

Project training settings preserve unknown fields; global configuration has no
enabled flag and uses bounded atomic publication. Restoring enabled settings
preserves saved manual mutes; explicit arming unmutes only selected existing guide
lanes. The source 150 ms lead, original-song-time windows and no-lyrics period
fallback are preserved. Sing-turn underlays retain approved glyph paint.
Verified with 557 Rust tests, native nonzero PCM/DSP, hidden four-process UI,
three-launch empty-project and existing export regressions, normal/UI builds and
84 exact native frames. Common native overflow safeguards provide bounded
sixteen-lane scrolling, keyboard reveal and full-name tooltips; current production
has no corresponding maximum-label safeguard. This is not production parity.
See [Carry review](CARRY_LINE_REVIEW.md) for evidence and open qualification.

Effective BPM, native analysis progress and heard-clock count-in dots now use shared
UIKit controls. Typed rate receipts gate accepted edits/Save/navigation; monitoring
releases ownership first, and ordinary playback/mixer commands remain queued. Exact
playback command serials protect rapid toggle intent from older receipts. The verified
checkpoint passes 576 Rust tests and hidden timing/monitor/Carry/empty workflows;
35 historical full frames remain exact and 49 lyric frames differ only at the new
active BPM footer, with approved lyric-region hashes unchanged. See
[transport timing review](TRANSPORT_TIMING_REVIEW.md) for evidence and limitations.

## Native language and mounted-view refresh

`locale_service` owns system discovery, preference reads/writes and selection receipts;
`i18n` holds the current locale and build-generated source dictionaries in memory.
`locale_host` applies accepted revisions to mounted views without reopening native
audio. The header uses shared UIKit language controls and app-local focus handles.
Explicit player navigation focus wins over stale modal-close restoration, including
after Import disappears on successful library adoption. The hidden locale driver
covers all fourteen choices at both sizes, live playback, preserved draft, stale
receipt fencing and a real persisted-language restart. See [locale review](LOCALE_PORT_REVIEW.md)
for test/capture counts and the remaining translation and platform scope.

## Dell Windows native qualification (2026-11-08)

The isolated Dell native copy builds the Rust app and all three MSVC helpers
without Node. Actual saved-graph playback, native pitch analysis, Save and restart
pass on Windows with eight hidden, muted captures. The stable content viewport
is 1280×800 at scale 2; outer/client dimensions agree and all eight resize hit
codes pass. A GUI-subsystem test host keeps PowerShell/Python console-free;
foreground identity remains unchanged throughout the verified graph run.

Qualification found and corrected a missing Windows no-console flag in native
analysis and read-only staging flush handles that Windows rejects in Save,
Drive adoption, model download and stem export. Shared Rust checks pass 765 tests,
zero failures, two ignored. The Drive UI follow-up remains open after correcting
its test-only comparison of canonical Windows project paths. See
[Windows native review](WINDOWS_NATIVE_REVIEW.md) for exact identities, failed
attempts and remaining scope. Live FPS, production parity and full Windows
scenario/hardware/service/packaging coverage remain unqualified.

The follow-up [Windows filesystem checkpoint](WINDOWS_FILESYSTEM_REVIEW.md)
resolves directory moves held by child writer handles, concurrent atomic
replacement and mandatory WAV read-lock interactions. That checkpoint
passes 718 Windows tests and 770 Mac tests (two ignored on each). A fresh combined
Dell batch passes 52 hidden, muted images across six actual app processes for
graph open/analysis/playback/Save/restart, Drive writer/account/cancellation and
streamed adoption/native playback/Save/offline reopening. Foreground, frameless
geometry and all eight resize guards pass; resource samples are archived and
live FPS remains unmeasured. The intermittent Mac engine-probe timeout remains
open despite the final passing full suite. This is partial platform qualification;
other native workflow UI cases, production parity, hardware/models/services,
Linux and packaging still require verification.

The subsequent [Windows UI workflow checkpoint](WINDOWS_WORKFLOW_REVIEW.md)
qualifies four additional actual native UI paths: header rename, library Copy/Move,
project deletion and training recording/export, with 41 successful captures across
four app processes. This covers native capture PCM replay and actual WAV export,
not physical microphone capture or OS chooser presentation. All owned processes
are retired. Narrow-header clipping and production visual parity remain open.

The [header layout follow-up](HEADER_LAYOUT_REVIEW.md) closes the observed narrow
title-field border clipping and Open-label final-letter loss. Mac and Dell title
workflows plus the Mac locale workflow pass with 71 captures and unchanged focus.
A strict native before/after comparison confines all 1,212 changed pixels to those
two header regions. This is defect evidence, not a production parity claim.

The [Linux native checkpoint](LINUX_NATIVE_REVIEW.md) restores the ALSA provider,
verifies actual kernel underrun recovery and passes the 101-capture native workflow
batch on VM 403. Its source/binary/image identities and private-display foreground
records are independently verified. This covers the listed workflows with kernel
loopback audio and software graphics. Physical devices, native chooser presentation,
live Google/model releases, hardware GPU/Wayland, packaging and production parity
remain unqualified. The subsequent [Settings inventory follow-up](LINUX_SETTINGS_REVIEW.md)
tracks a reproduced exclusive-owner inventory defect separately from that baseline.

The Settings follow-up now passes final 771-test Rust suites on Mac/Linux,
six/seven native suites, 16 Mac and 21 Linux Settings/graph captures, and the
actual kernel busy-inventory/underrun probe. It preserves separate inventory work,
opaque UIDs and native route admission. Both isolated Linux lab containers are
stopped with source/caches retained. Hardware/hotplug and broader port gates remain open.

The [default-route capability follow-up](DEFAULT_ROUTE_REVIEW.md) publishes native
inventory when the actual output UID changes implicitly on Play, preview or cues.
Mac/Linux simulated cross-rate default churn, explicit-selection retention and
real-mode fixture rejection pass, plus 45 hidden Settings/graph captures across
ten launches. Full Rust suites remain 771 passes, with six/seven native suites and
actual kernel underrun recovery passing. Raw transaction intake, asynchronous
device-loss document retention and physical hotplug remain open as detailed there.

The subsequent [native reply intake checkpoint](REPLY_INVENTORY_REVIEW.md) covers
raw transaction capability receipts and retained-Copy ownership transfer. Final
Mac/Linux suites pass 775 tests each, and empty-project, Copy/Move, Settings and
graph/Save/restart workflows pass 99 hidden captures across 18 launches. The
independent archive verifies source/binary/image pins, foreground and retirement.
Device-loss recovery must still retain unsaved documents and safely reprepare
audio without the destructive ordinary Open lifecycle; offline working Save
adoption, physical hotplug and broader release qualification remain open.


The [native output recovery checkpoint](OUTPUT_RECOVERY_REVIEW.md) now separates
runtime transport loss from invalid new Open. It retains the document, accepted
unsaved mix, editor draft and stopped clock; Settings Retry reprepares the exact
requested output paused. Hash-bound working Save adoption preserves the same
editor and visible lyrics rather than reopening the document. Source handoff
configures the loop, fences callback-applied paused seek, then resumes Play.
Final Mac/Linux Rust suites pass 781 tests each (two ignored), and 185 hidden
captures across 29 launches pass independent image/state/hash/retirement checks.
The normal Mac build is restored and only the exact two Linux lab containers are
stopped, with the existing host audio owner and other containers unchanged.
Physical hotplug, training/monitoring recovery, forced publication-read UI faults,
latest Windows deltas, production parity and live FPS remain unqualified; legacy
Mac capture geometry exceptions are explicitly recorded in the review.

The subsequent [publication retry follow-up](PUBLICATION_RECOVERY_REVIEW.md)
closes the covered publication-read fault UI gap: actual metadata quarantine,
receipt retention through notice/Player/Settings Escape, duplicate Save refusal,
changed-metadata refusal, exact repair and paused Retry followed by native Play.
Notice keyboard ownership now agrees with its layer above progress, with mounted
editor focus restored on dismissal. Header Save visibly disables through shared
UIKit. Final suites pass 781 tests on each platform, with 267 hidden captures/37
launches independently checked. Active-Save cancellation is controller-tested;
the notice-over-progress case holds renderer state explicitly. Healthy live-helper
publication failure, pre-admission native pause evidence, monitor/training
handoffs and actual active-writer key routing remain unqualified.

The [healthy live-helper publication test](LIVE_PUBLICATION_REVIEW.md) subsequently
qualifies the ordinary unmonitored case: a real Save/read fault leaves the same
native helper paused through seven fresh backend-owned status observations;
exact repair/Settings Retry creates a paused replacement, then native Play
advances. The test bypasses host cached-status admission and never kills the
healthy helper. Final suites pass 781 tests each, with 110 final PNGs/14 apps on
Mac/VM403. Monitor/training handoffs and pending-Pause failure remain unqualified.

The [monitoring publication fix](MONITOR_PUBLICATION_REVIEW.md) now preserves the
independent monitor lease during working Save and defers playback preparation to
the matching clean Stop acknowledgment. Epoch/cancellation guards, retained busy
intent, FIFO owner transfer and queue recovery fences avoid premature output
acquisition or lost queued intent. Mac automatic Stop and a separate held-busy
controller adapter pass; the adapter is not a real concurrent-writer test. Both
normal suites pass 781 tests, with 157 final images/20 apps checked independently.
Linux coverage is its production unavailable-monitor policy plus ordinary native
regressions, not monitoring integration. Training/hardware and remaining gates
are explicitly unqualified in the review.


The [training output recovery checkpoint](TRAINING_RECOVERY_REVIEW.md) retains
Identify sessions, completed answers and dirty song edits after owned native
output failure. Standalone Continue replays the current prompt; song-backed
Continue stays disabled until actual Settings Retry restores paused song output.
Both normal suites pass 782 tests (two ignored); final functional evidence has
88 PNGs/14 apps. Linux vocal scoring/navigation now uses measured header controls.
One Mac song foreground observation is interrupted by other-application activity,
so unchanged foreground is not a blanket pass. An existing escaped-child
cancellation test failed once, then passed isolated and in the unchanged full
rerun; its cause remains unresolved. Vocal/microphone/recording fault recovery,
hardware/services, complete visual/temporal/locale/accessibility and release
qualification remain open. The full desktop goal remains active.


The [vocal input recovery checkpoint](TRAINING_INPUT_RECOVERY_REVIEW.md) closes
owned synthetic-input failure during vocal Cue and Completing. A common bound
capture/freshness guard pauses before cue advancement or result commitment;
Continue preserves completed receipts and obtains a fresh native capture. Actual
PCM/CREPE cases pass on Mac/VM403, alongside vocal/Identify/guided and standalone/
song-backed output recovery. Both normal suites pass 783 tests (two ignored),
with 62 final images/10 apps independently checked and stable foreground.
This does not qualify physical microphone/hotplug, active-recording faults,
song-backed vocal input faults, all task/state combinations, visual parity,
live FPS, latest Windows or release readiness. Full desktop work remains active.


The [active recording recovery checkpoint](RECORDING_RECOVERY_REVIEW.md) fixes
late Continue events restarting an already-running microphone: capture intent
changes only when an active paused Run actually resumes. Native active-recording
child death now has connected Mac/Linux evidence: the RAM-only current take is
lost and reported, completed WAVs stay byte-exact, and actual Continue creates and
exports a fresh take without ghost pending state. Both suites pass 784 tests
(two ignored); 76 final images/10 apps and four decoded finished takes/exports
are independently checked with foreground unchanged. This is not crash-audio
salvage: finalized staged-WAV publication recovery, graceful device-error finish,
physical hardware/choosers, full visual/temporal/locale/accessibility, latest
Windows and release qualification remain open. The full desktop goal is active.


The [completed recording publication checkpoint](RECORDING_PUBLICATION_REVIEW.md)
adds an identity/content-pinned recovery take for finalized native WAVs stranded
by host/helper publication failure. Existing Save training WAV promotes into the
ordinary retained root, preserves unrelated files on export failure, and retries
with byte-exact repeated exports. Original-file pinning, conservative cleanup and committed-retry fences are covered.
Mac/VM403 suites pass 808 tests (two ignored);
72 final images/10 hidden apps, 16 decoded WAV copies and exact process/container
retirement are independently checked with foreground unchanged. This covers
controlled publication collisions for the current attached take. RAM-only crash
audio, restart discovery, real disk-full/permissions, physical hardware/choosers,
full parity/performance, latest Windows and release qualification remain open.
The full desktop goal remains active.


The [native macOS package checkpoint](MACOS_PACKAGE_REVIEW.md) adds a maintained
standalone `.app` assembler with native dependency/architecture/minimum-OS checks,
exclusive publication, OFL notices and optional ad-hoc signing. Native helpers load
bundled CREPE/training data from Resources while loose runtimes remain adjacent.
The current arm64/macOS-26 local preview passes 23 assembler tests, the 808-test
Rust suite, actual signatures/relocation, muted native training, normal hidden
startup and 29-image/four-app clean-environment functional checks. This is local
preview verification; notarization, older systems/universal and other-platform
packaging, real hardware/services and full parity/release gates remain open.

### Desktop lifecycle completion — 2026-11-08

Startup and macOS Dock reopen now share the native window factory, with a weak
player registry and one-time startup project arguments. Native-only geometry
persists the display, last normal frame and maximized state; restoration clamps
against connected work areas (default 1240×820, minimum 940×600). Fullscreen frames
are excluded. Quit and final player release share idempotent preference/service
teardown. The Mac application menu supplies Settings, Close Window and Quit;
Cmd/Ctrl+, opens Settings idempotently, while the header gear retains its toggle.
Global window actions defer reentry until GPUI input dispatch completes.

Verification: four geometry/storage unit tests pass, regular and `ui-tests` Mac
builds pass, and `tests/test_native_desktop_lifecycle_ui.py` passes hidden and
muted with isolated preferences. It checks repeated actual Cmd+, input, native
Close action, entity release, close-time geometry flush and the production reopen
callback adapter, including duplicate-open prevention and restored 940×600 size.
Both minimum-size captures were inspected. The process exited and sampled
foreground identity remained unchanged. The check invokes the callback adapter;
it does not inject an OS Dock event, directly verify training-profile persistence,
measure animation performance, or establish production visual parity. Windows
and Linux retain GPUI's existing exit-on-last-window behavior; this new lifecycle
UI check is macOS-only. Evidence: `/tmp/singz-desktop-lifecycle-20261108-v2`.


### Wake recovery and automatic harmonic-key analysis — 2026-11-08

GPUI system-wake notifications now reach the native Drive worker. Wake shortens
network backoff to the source scheduler's two-second retry without invalidating
an active upload or account epoch. Suspended/signed-out/disabled services and
local validation blocks remain fenced. Eighteen Drive worker tests pass against
isolated local HTTP fixtures; actual OS sleep/wake delivery and live Google
service behavior were not exercised.

Automatic analysis now computes melody and harmonic key independently. A song
with current melody and a stale/missing key, or a harmonic-only song, can derive
its key using the existing native analyzer. Only builtin bass/guitar/piano/other
roles participate, with source-matched RMS admission. Input stamps, cancellation
and load epochs fence results; successful independent parts survive another
part's detector failure. Current and future key stamps are preserved at commit.
Accepted results use the automatic-analysis Save queue for existing projects;
blocked Save admission keeps the pending intent. Melody-histogram fallback is
strictly display-only and cannot authorize song-key training or stamp a key.

The full Mac Rust suite passes 823 tests (two ignored). Regular and ui-tests builds
pass. Two hidden, muted real-native key cases pass: current-pitch/stale-key healing
and harmonic-only/missing-key derivation both persist C major/version2, preserve
foreign metadata, and preserve current pitch or its absence respectively. The
processes exited and sampled foreground identity stayed unchanged. Both rendered
candidates were inspected; they establish no production visual-parity or live
performance claim. Evidence: `/tmp/singz-native-key-20261108/ui`. Windows/Linux
qualification of this new analysis path remains open.

The existing hidden vocal-analysis regression also passes with this build: real
native pitch detection, mixer/keyboard Save and external-edit conflict checks,
plus cancellation/reaping of three analyzer processes across replacement/quit.
Its two app launches used isolated preferences and sampled foreground monitoring
remained stable. Evidence: `/tmp/singz-native-key-20261108/legacy-analysis`.


Native portable package qualification now covers the new key-analysis path on
Windows and Linux, plus normal packaged startup and graceful close. See
[desktop packaging](DESKTOP_PACKAGING.md) for commands, actual platform scope,
Windows UTF-8/file-permission fixes and remaining release gates.


Native Drive retirement/name reuse follow-up (2026-11-09): local operation receipts,
immutable accepted upload recovery and exact-ID catalog-last retirement now pass
1,009 Rust tests, both native builds and the actual two-size lifecycle journey
(two hidden launches, 20 inspected captures). Sole-project Delete, typed Rename,
same-name replacement admission, retained media and truthful automatic continuation
are covered. See [retirement review](RETIREMENT_DRIVE_REVIEW.md) for source/binary
pins, preserved failures and real-account/platform/visual limits.
