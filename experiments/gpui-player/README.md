# GPUI desktop interface prototype

A standalone native port of the SingZ desktop interface. Normal launches now read real
project folders and use the shared C++ engine for playback. The runtime and its dedicated
build path require no Node or Electron. See [native build and current integration scope](NATIVE_INTEGRATION.md).

Use `SINGZ_GPUI_DEMO=1` for the original silent sample fixture and visual comparisons.
Native input capture, live pitch, Settings meters, experimental same-device monitoring
and explicit Save are available. Native training Start now connects cues, CREPE,
hold/scoring and running/summary screens; setup, programs and completed progress
now survive restart. Training-only microphone sample recording and retained-WAV
export are implemented; hidden two-size recording/export UI and direct native
input checks pass, together with the final build/unit/training regressions and
84/84 strict native baseline frames.
Native lyrics lookup, version search, transcription,
alignment and editing are connected. Lyrics writes record durable pending-sync
intent consumed by the separate native Drive worker; see [Drive qualification](DRIVE_PORT_REVIEW.md).
Authenticated adoption now receives actual streaming download bytes/speed;
[progress verification](DRIVE_PROGRESS_REVIEW.md) separates held-transfer tests,
writer UI regressions and remaining adoption/platform qualification.
[The combined adoption workflow](DRIVE_ADOPTION_REVIEW.md) now verifies gated
streaming UI, real cancel/resume, catalog open, native playback/mixer/Save and
offline restart after the local server is stopped, at both content sizes.
Monitoring remains active after closing
Settings; its persistent header control opens Settings or stops monitoring and
releases input while restoring the paused song. The healthy playback output
route is no longer shown as a monitoring owner. Active-monitor/narrow header
titles and physical microphone/audible monitoring still need qualification.

Requires Rust and GPUI Kit's native platform prerequisites (macOS 15+ for this Mac setup).
Keep the sibling UIKit checkout at `../singz-ui`: Cargo resolves `singz-uikit` from its
`gpui` directory.

```sh
bash scripts/build-gpui-audio.sh
cargo run --manifest-path experiments/gpui-player/Cargo.toml
```

## Native engine discovery and instructions

Native separation discovers system Demucs first, including `SINGZ_DEMUCS` and
Python module launchers with the expanded GUI PATH, then probes a validated
installed Torch/ONNX pack. `SINGZ_NO_SYSTEM_ENGINES` disables system discovery.
Split uses the resolved command: system Demucs receives the original private-copy
audio, while the pack uses native PCM preparation. Backing/combined separation
still requires the installed UVR pack.

The source's legacy engine instructions dialog is implemented with selectable
installation text, Copy, GitHub, Recheck and native keyboard/dismissal behavior.
It opens only for failed statuses without `needsModels`; ordinary exhausted
discovery reports missing models and opens the model manager. Its independent
checker cannot cancel active source jobs, and generation/session plus probe-start
freshness fences protect readiness and dismissal from stale receipts.

The engine checkpoint passes 338 Rust tests and hidden muted UI v4, including
both stale-probe orders, native command selection/copy and actual failed-startup
Open recovery. All 84 existing native regression frames and 49 glyph regions
remain exact. Evidence is archived in `gpui-engine-setup-20261107/REVIEW.md` under
the session visualization directory. Matched production captures and
Windows/Linux execution remain open. Reproduce the local fake-engine UI checks
with the `ui-tests` app build:

```sh
python3 experiments/gpui-player/tests/test_native_engine_setup.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-engine-setup
```

## Native project deletion checkpoint

Normal native catalog cards now identify deletion by project directory and open
an inspected confirmation with name, stem/lyrics counts and byte size. Root and
writer leases, captured metadata/tree identities and reversible hiding protect
confirmation against external changes. Durable local deleted-sync intent commits
before cleanup; earlier failure restores the project and cleanup failures report
a recovery path. This does not connect Drive accounts or remote reconciliation.

Deleting another project keeps actual playback/status responsive. Deleting the
loaded target revokes its epoch, joins source-bound jobs and releases native
handles; failure reopens the authoritative active project paused, including a
private working copy's saved target. Success stops/closes the deleted loaded song
and prevents stale receipts from restoring it, following the production handler.
Errors are visible inline offline as well as when Drive is configured.

The current unit/domain checkpoint passes 415 Rust tests (0 failed, 2 ignored)
in `/tmp/singz-project-delete-unit-v2.log`. Hidden UI v4 passes at both desktop
sizes with 12 PNGs and four actual project deletions, independent filesystem and
exact deleted-intent ledger checks, unrelated playback advancement, paused
conflict recovery and loaded-song clear/no resurrection. The real native catalog
intrinsic-height/minimum-row/outer-scroll correction makes 1060 controls reachable;
the immutable demo fixture path is unchanged. All 84 raw native regression frame
pixels match; strict-diff generation, picker/import regressions, final unit/normal
build and archive publication remain pending. See
[project deletion review](PROJECT_DELETE_REVIEW.md). Windows/Linux and matched
production captures remain unqualified; the full desktop port is incomplete.

## Current interface fixture

The following describes `SINGZ_GPUI_DEMO=1`; normal native operation is documented above.

The catalog follows the production `DropScreen`: equalizer hero, drop/browse area,
projects location panel, title search and project cards. Selecting a card opens the player.
All cards preview the same 192-second fixture; they do not load different audio. Browse,
project deletion, folder changes and backend actions explain their prototype limitations.

The player has six stem lanes, mute/solo, gain rails, a waveform ruler and seek interaction.
The footer follows `Transport.tsx`: restart, play/pause, clock, loop, song output, metronome,
line continuation, transpose, tempo, BPM state, Karaoke, Split and Stem files. Play advances
a silent clock. Transpose/tempo/mix controls change local state. Backend-only actions do
not pretend to process or save audio. Karaoke reveals lyrics and the sample pitch strip and
mutes the vocal lane; Guide vocals controls the local guide state.

Settings opens as a viewport modal above the prior page. The Audio view contains playback
and input selectors, native-playback and headphone checkboxes, a microphone meter,
monitoring route/graph and a gain slider. Menus, checkboxes and gain keep local draft state;
they do not apply device routes. Monitoring is unavailable without a native audio service.
The content scrolls inside the modal; Close, Escape and the scrim return to the prior page.
Player animation is paused while the modal is open.

Native mode implements playback, saved lyrics/pitch, tempo/transpose, vocal pitch analysis,
manual project saving and persisted output routing through the actual device inventory. Fresh analysis, separation and other remaining integrations are
listed in [native integration](NATIVE_INTEGRATION.md). Fixture interactions alone
are not evidence of backend availability or audio performance.

The header Log button opens a native diagnostic dialog with selectable rows,
current/past sessions, Copy and Save to file. Normal native launches now record
real project operations, engine selection/failures, separation stages and streamed
engine stderr in durable per-launch sessions under the native config's `logs`
directory. The live ring keeps the latest 4,000 entries; past sessions show the
same-sized tail with the full count, and Save exports the full selected past file
or the current live ring. Session reads and exports use an independent worker and
async selection/session fences. Destination publication refuses links and
unapproved overwrites; accepted native Save choices can safely replace an ordinary
file. Actual native save-dialog presentation is not yet verified.

The diagnostics checkpoint passes 359 Rust tests (2 explicitly ignored real-engine
cases), recorded in `/tmp/singz-diagnostics-unit-final.log`. Final hidden diagnostics
UI v6 passes with 32 PNGs across seed/review/short launches at both desktop sizes;
model, source, engine-setup and sidebar regressions also pass. Checks include long
Cyrillic/emoji rows at the UTF-16 boundary, intrinsic body sizing, large-to-short
session resizing, fresh session menus, Copy timing/restoration, follow-scroll,
full past export and stale Save receipts. The normal build passes; 84/84 strict
native frames and 6/6 historical native Log fixtures remain identical. See the
[completed diagnostics review](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-diagnostics-20261107/REVIEW.md). Earlier Log screenshots still differ from production; see
[screen inventory](SCREEN_PORT_STATUS.md) and [Log port review](LOG_PORT_REVIEW.md).
No fixtures or visual thresholds were changed. Actual save-dialog presentation
and Windows descendant cleanup remain unqualified.

## Shared UIKit and assets

Reusable native controls live in `../singz-ui/gpui`: pills, icon buttons, play control,
checkboxes, selectors/popups, sliders, modal material, scrollbars, badges, search and
transport controls. Screen composition stays in this project. Production SVG paths are
reused rather than replaced with font glyphs.

Fonts are owned by the sibling UIKit crate and distributed in UIKit's `dist/fonts`.
`singz_uikit::init(cx)` registers its bundled native faces once per App; this prototype
keeps no private TTF copies. The native build consumes these distributed assets directly
without web tooling. The explicit native families select the heavier visual outlines by family name;
Windows aliases normalize style metadata while macOS retains its original metadata.
Both variants have identical static glyph outlines and layout tables. License and source provenance ship with the distribution.

See [Dell Windows verification](WINDOWS_PORT_REVIEW.md) for font matching,
background interaction results, measured resource use and remaining platform gaps.
See [Linux VM 403 verification](LINUX_PORT_REVIEW.md) for Linux captures,
frameless/background fixes and software-Vulkan qualification limits.

The waveform fixture uses normalized peaks exported from the real Electron renderer after
it decoded the six FLAC stems. `assets/review-peaks.bin` includes six arrays of 192000
float32 buckets. Decoder/fixture provenance and exported per-lane metadata are described
in [player_reference.md](player_reference.md). These peaks are a shared visual fixture,
not a native decoding implementation.

The [approved native highlighting standard](LYRICS_HIGHLIGHT_STANDARD.md) takes precedence over Electron for the lyric paint effect.

The original six-line verse repeats to fill the fixture. Native lyrics use shaped glyph
metrics, the production line metrics, 150ms anticipation, a partial glyph sweep and the
approved native word halo. Active text retains the approved layered paint: readable base,
12-slice amber feather, an 18px advancing bright core, and eight cached halo-opacity levels.
The light moves through glyphs instead of selecting whole letters. Centering follows line changes; wheel/scrollbar
input lets the singer read elsewhere until the next line. Geometry/shaped text and glow
images are cached. Rendering and
Chromium rasterization differences remain under review; no screen is certified pixel-perfect.

The macOS renderer has an opt-in [GPU grain extension](vendor/gpui-pre-apple/GRAIN_EXTENSION.md).
It composites the source SVG noise above the whole scene in one GPU pass, shared by live
windows and hidden captures. Runtime shaders avoid requiring Xcode's separate Metal
compiler toolchain. The hidden smoke suite validates its output against an independent
blend formula. Other rendering backends still need the same effect. The process-local
text policy matches Electron's antialiased CSS without changing system font preferences.

## Normal and test builds

The normal build supports the interactive silent prototype. Test adapters are enabled only
with `--features ui-tests`; normal builds do not run smoke or review capture tasks.
All automated checks stay hidden and dispatch input inside the app. They do not activate
windows or send global pointer/keyboard input.

```sh
cargo build --manifest-path experiments/gpui-player/Cargo.toml --features ui-tests
SINGZ_GPUI_BACKGROUND=1 SINGZ_GPUI_UI_SMOKE=/tmp/singz-gpui-ui-smoke \
  experiments/gpui-player/target/debug/singz-gpui-player
SINGZ_GPUI_BACKGROUND=1 SINGZ_GPUI_REVIEW_CAPTURE=/tmp/singz-gpui-review \
  experiments/gpui-player/target/debug/singz-gpui-player
```

The smoke driver exercises real click dispatch, catalog search/open, Settings controls and
scrolling, and player controls. It captures native renderer images and fails on incorrect
state changes. The review adapter captures catalog, Settings and player at 1280×800 and
1060×640, plus deterministic paused lyric sweep and line-boundary states at 1280×800.
Hidden macOS windows suspend normal display callbacks, so manually stepped offscreen
captures establish neither live FPS nor smooth scrolling cadence.

Follow [UI_REVIEW.md](UI_REVIEW.md) and the linked interface-port-review skill for the real
production-reference capture contract, required state matrix and strict comparison loop.
References and candidates must use identical fixtures, locale, viewport, device scale,
timestamps and color profiles. Keep old batches immutable. Interaction success is separate
from visual parity. [REVIEW.md](REVIEW.md) records the earlier findings;
[player_reference.md](player_reference.md) records the resolved fixture blocker and measured
production player geometry.

```sh
python3 experiments/gpui-player/tests/test_compare_ui.py
python3 experiments/gpui-player/tests/compare-ui.py \
  --reference /tmp/reference.png --candidate /tmp/candidate.png --out /tmp/diff
```

## Performance measurements

The background throughput benchmark renders and reads back real GPU images without display
callbacks. It reports completed images per second, frame intervals, draw/readback wall time,
process CPU/RSS, and available system GPU utilization. It checks that the advancing highlight
was drawn. These results are distinct from display FPS:

```sh
python3 experiments/gpui-player/tests/interface-offscreen-perf.py
```

The older display-cadence telemetry runner remains available:

```sh
python3 experiments/gpui-player/tests/interface-perf.py
python3 experiments/gpui-player/tests/test_perf_gate.py
```

The runner builds the optimized development binary, starts its own hidden process, warms
up for five seconds, measures for twelve seconds and cleans up that process. Use
`--skip-build` only when the binary matches current source. The default JSON report is
`/tmp/singz-gpui-interface-perf.json`.

Reports distinguish UI draw cadence from display presentation FPS. They include frame
interval percentiles, lyric CPU paint time, process CPU (100% means one logical core),
memory and available IOAccelerator utilization. GPU counters are system-wide and include
other apps; unavailable counters are reported explicitly. Insufficient hidden-window
cadence is unmeasured/failing telemetry, never zero-filled or interpreted as smoothness.
The gate requires complete telemetry windows; optional CPU budgets are configured by the
runner flags. Offscreen stills and timestamped highlight samples are not an FPS benchmark.

## Window chrome

The macOS window is frameless with native traffic lights inside the 52px SingZ header.
Header content reserves 92px on the left; fullscreen releases that space. Native resize,
minimize, close and fullscreen controls remain native. Drag/double-click handling delegates
to the platform preference; controls preserve GPUI click tracking while preventing header
drag propagation. Windows also draws into the complete window frame, reserving
150px on the right for UIKit's minimize/maximize/close controls. Native edge and
corner hit tests retain resizing. Linux uses the same controls with client-side
resize grips and an opt-in zero-padding component frame. X11 is verified on
VM 403; Wayland runtime checks remain outstanding.

The pitch strip uses a separate toolbar for Note bars, Fit and the compact
microphone status. The key/piano roll stays below it, and short-window stem
lanes scroll within their own clipped viewport rather than covering the pitch panel.

Earlier manual Mac checks covered drag, zoom/restore, minimize/restore and resize. Hidden
scene captures omit AppKit traffic lights and the OS shadow, so content parity does not
certify native chrome parity on any platform.

The hidden 120 Hz lyric-paint adapter records first-word, final-word and line-boundary
sequences (363 samples), successful advancing-halo image draws, hashes and exact crops:

```sh
SINGZ_MUTE=1 SINGZ_NO_SYNC=1 SINGZ_GPUI_BACKGROUND=1 \
SINGZ_GPUI_LYRICS_REVIEW=/tmp/singz-gpui-lyrics-review \
  experiments/gpui-player/target/debug/singz-gpui-player
```

Build with `--features ui-tests` first. These settled timeline samples establish paint
evidence, not live presentation FPS. Historical approved captures use older geometry
and timing; do not claim whole-image pixel identity from the restored paint algorithm.

Vocal training has native home/setup/running/summary and filled-progress screens,
with seven exercise choices and initial program curricula. Test C4 and Start use
native reference audio with or without a loaded song. Start connects exclusive
CREPE capture, a 1.5-second hold and scoring. Setup, selected programs and normalized
completed history persist across restart. Loaded-song preparation offers four
recipes with key/transpose handling and explicit range review before Start; the
summary returns to the paused song. Training-only sample recording now attaches
to that existing owner-4 microphone, captures raw mono PCM16 before CREPE for at
most 30 seconds, retains a private native WAV and offers native Save training WAV.
Stop/navigation finishes an owned take; monotonic take IDs and a permanent
attachment fence reject delayed receipts after leaving and returning to the same
practice. Export runs on a worker and never removes the retained original or
marks project sync dirty. General song recording,
remaining task/state coverage and full visual/audio parity remain open.

The recording checkpoint passes 390 Rust tests (0 failed, 2 ignored) in
`/tmp/singz-training-recording-unit-final.log`, and the native helper build passes in
`/tmp/singz-training-recording-native-build.log`. The UI-feature build v2 and actual hidden two-size driver pass in
`/tmp/singz-training-recording-ui-v2` (12 PNGs, 6 WAVs), including native
Tab/Space/Enter behavior and nonoverlapping recording controls/status. Direct
native input v2 passes raw 8 kHz sample and exact 30-second-cap checks; prior
input/microphone/monitor regressions also pass. Final unit and normal application builds, the training-run regression and all
8 comparator self-checks pass; 84/84 full native baseline frames match strictly. Save-path
interception exercises the actual export worker, not a presented OS chooser. See [training recording review](TRAINING_RECORDING_REVIEW.md)
for scope, evidence and unqualified hardware/platform boundaries. The
[completed functional checkpoint archive](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-training-recording-20261107/REVIEW.md)
contains the review. The UI process provided 56 CPU samples (median 1.52%, peak
86.08%); helper CPU is separate, GPU counters are system-wide, and hidden live
display FPS remains unmeasured.
See the screen inventory and native integration document for the remaining scope.

Native training checks (after the native helper and `ui-tests` app builds):

```sh
python3 experiments/gpui-player/tests/test_native_training_only.py experiments/gpui-player/target/debug/singz-gpui-audio
python3 experiments/gpui-player/tests/test_native_training_ui.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/training-audio-ui
python3 experiments/gpui-player/tests/test_native_training_capture.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/training-capture-score
python3 experiments/gpui-player/tests/test_native_training_progress.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/training-progress
python3 experiments/gpui-player/tests/test_native_training_preparation.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/training-preparation
```

The UI check creates isolated fixtures/preferences and runs hidden with muted output.
The helper check accepts `--hardware` for muted real-device verification.

The native lyrics editor uses gpui-component Input/Textarea states and shared
SingZ UIKit controls. Editing, timing rows/words, undo, replacement/help, vocal
envelopes and independent conflict-safe lyrics Save are connected. Working-copy
publication carries the accepted lyrics, and queued project Save waits for the
editor and its save receipt. Alignment is a preview until explicit Save: Qwen
uses native llama-server/crispasr, while Precise uses the existing pack's MMS
runtime. Missing model downloads require the editor's explicit consent.

The editor now uses the source dictionaries for its controls, help, consent,
placeholders and plural hints/verdicts. A dedicated help scroll handle keeps the
localized confirmation button visible on autofocus and Tab, including the compact
Russian layout. See [the locale review](LYRICS_EDITOR_LOCALE_REVIEW.md) for the
hidden bilingual workflows, source identities and remaining parity limits.

```sh
python3 scripts/gen-gpui-lyrics-editor.py --check
python3 experiments/gpui-player/tests/test_native_lyrics_envelope.py experiments/gpui-player/target/debug/singz-gpui-audio /tmp/native-lyrics-envelope
python3 experiments/gpui-player/tests/test_native_lyrics_editor.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-lyrics-editor
python3 experiments/gpui-player/tests/test_native_lyrics_align.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-lyrics-align
```

The alignment UI suite uses deterministic runtime protocols and tiny local model
headers; it does not establish neural quality. The opt-in Rust test
`real_native_alignment_cold_warm_and_optional_precise_receipt` instead requires
explicit local project, output, helper, engine and model paths. A private 9-second
offline speech fixture passed real Qwen cold and cached runs, with 100% word
matches and no lyrics writes. That fixture does not qualify general singing
quality. Actual Precise inference remains unverified without its installed MMS
weights. Production-matched editor screenshots, all-locale/accessibility and
Windows/Linux integration remain open. Hidden captures
cannot establish live FPS or smooth display cadence.

The native lyrics sidebar now connects automatic LRCLIB lookup and the inline
Change… version picker. Native tag reading and filename/tag cleanup feed the
full artist/title retry ladder. Search ranks synced entries before text-only
entries and then by duration; text-only entries cannot be applied. Candidate
selection publishes immediately. Source/credit and check feedback follow the
accepted document: LRCLIB and edited lyrics offer Check & align and, when
available, Precise; transcribed lyrics retain Edit and Change… without those
alignment links. Missing speech/alignment models require explicit consent before
download. Transcription, alignment, progress, Retry and cancellation use native
workers. Sidebar alignment publishes an accepted result directly; editor
alignment remains an unsaved preview until explicit Save. Mismatches preserve
the saved words.

Publication prepares glyph masks off-thread and checks the captured lyrics
fingerprint under the project writer lease. A commit that beats cancellation
still returns its accepted document/identity before queued Edit, Save or a
replacement job proceeds. Editor Save owns its credit snapshot, clears stale
alignment/lookup metadata, and preserves unrelated fields. Successful lyrics
writes mark the native `sync.json` dirty ledger; a ledger failure reports that
lyrics were saved locally rather than reporting an unsaved draft. The ledger now feeds the native Drive worker and upload scheduler; live service and
remaining compatibility qualification are tracked in [Drive review](DRIVE_PORT_REVIEW.md).

```sh
python3 experiments/gpui-player/tests/test_native_lyrics_sidebar.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-lyrics-sidebar
```

The archived hidden, muted sidebar run at
`gpui-lyrics-sidebar-20261107/sidebar/result.json` passed its two-size search, conditional-action,
consent, inference-protocol, publication, conflict, cancellation and queued
working-copy Save checks. It uses local HTTP and deterministic inference
protocols, so it does not establish live LRCLIB availability or neural quality.
The separate real Qwen receipt at `/tmp/singz-sidebar-real-qwen` records cold/warm
alignment and transcription on a short offline speech fixture, with no
`lyrics.json` write. It does not qualify general singing quality; actual Precise
inference remains blocked by missing installed MMS weights. The sidebar/editor,
alignment, source, import and picker workflow regressions pass; 35 native fixture
screens and all 49 comparable glyph regions are unchanged. Full native lyric
frames differ only in the source/action row. Evidence is archived in
`gpui-lyrics-sidebar-20261107/REVIEW.md` under the session visualization directory.
Matching production captures,
temporal parity, locale/accessibility and Windows/Linux sidebar qualification
remain open.

The native **Your projects** dialog opens from the header's Open control and the
catalog's Change storage link. It lists saved project names, badges and dates,
opens a selected song, and offers the native file browser. Folder selection,
detected cloud folders and Back to Documents use a native Rust worker: existing
projects are copied without deleting the old library; destination collisions
retain the existing destination. The chosen root persists in native library.json,
which preserves other fields and takes precedence over the initial environment
root. Closing the dialog lets an already chosen copy finish. Native project and
root writer leases plus before/after inventories prevent publishing changed data.

```sh
python3 experiments/gpui-player/tests/test_native_project_picker.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-project-picker
```

This test runs four isolated app processes, with hidden muted windows, exact
project-data integrity checks and a test-only folder chooser callback. Native
folder-dialog presentation/cancellation, Google Drive account/sync, production
visual parity, locale/accessibility and Windows/Linux remain unqualified.

Saved projects opened outside the library offer **Add to library…** in the
header. The native source-backed dialog supports Copy it in and Move it in,
blocks dismissal while busy and shows a nonblocking six-second success toast.
Copy keeps the existing helper playing through file transfer, including an
in-flight status/command epoch handoff. Move releases media handles before an
exclusive same-volume rename or safe cross-volume copy/publish/removal fallback.
Project and lyric fingerprints, native writer/root leases and staged no-replace
publication protect against external edits and destination collisions. Valid
stem-only projects are accepted without their missing original mix. The app
follows the imported project, preserving live mix, position and playing state;
subsequent Save targets the library copy.

```sh
python3 experiments/gpui-player/tests/test_native_library_import.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-library-import
```

The hidden muted fixture check forces Copy during an old helper status read,
holds file transfer, validates continuing audio, tests true Move and collisions,
stale navigation and captured-root identity, and checks toast focus/expiry plus
Save targeting. Actual cross-volume UI, Windows/Linux and production visual
parity remain unqualified; the EXDEV fallback is covered separately by Rust tests.

The header version number opens native **What’s new** from the existing bundled
release content, including the original Telegram image and four highlight icons.
A native worker stores monotonic acknowledgements separately from the Quick start
flag: fresh installs establish a baseline, returning installs see an unseen release,
skipped versions are collected newest first, and downgrades retain the newest seen
version. Startup waits for model checks and existing dialogs; Quick start waits for
release notes. Development builds suppress automatic notes; manual opening remains
available. The app resolves bundled release translations from the current native locale.
Full production visual, translation/layout and platform qualification
remain open.

```sh
python3 experiments/gpui-player/tests/test_native_whats_new.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-whats-new
```

The native model manager uses Rust-owned curl/tar jobs and the shared UIKit.
It supports platform-specific inventory, Get/Reinstall, progress, retry, manual
cancellation, first-run Skip, and Windows GPU/CPU preference. Its hidden test runs
against small local HTTP fixtures; it does not download or execute real AI models:

```sh
python3 experiments/gpui-player/tests/test_native_models.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-models
```

The worker preserves installed files after failed replacements, journals multipart
publication, and cancels/reaps its subprocesses on shutdown. Remote release-asset
qualification and strict production-dialog visual parity
remain open. Native audio import/splitting now reuses the installed inference pack:

```sh
python3 experiments/gpui-player/tests/test_native_title.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-title
python3 experiments/gpui-player/tests/test_native_source.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-source
python3 experiments/gpui-player/tests/test_native_source.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-source-real --real
python3 experiments/gpui-player/tests/test_shared_split_runner.py
```

The first run injects failures; `--real` uses the existing local ONNX/UVR weights
without downloading them. Both drive hidden file drop, Split, native seven-lane
playback and explicit Save, including backing-only separation of a FLAC project.
Save uses the shared native FLAC compactor and preserves float vocal WAVs. Working
copies remain private until Save. See `NATIVE_INTEGRATION.md` and
`SCREEN_PORT_STATUS.md` for remaining screens, parity and platform coverage.

The native Quick start tour filters steps to the current screen's controls and uses
shared UIKit anchors, cutout paint and balloon controls. Its English copy is embedded
from a source-checked JSON snapshot; no JavaScript runtime or Node build step is used.

```sh
python3 scripts/gen-gpui-quick-start.py --check
python3 experiments/gpui-player/tests/test_native_quick_start.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-quick-start
```

The UI test requires the `ui-tests` build. It checks both desktop sizes, keyboard
trapping and Back activation, input occlusion, undarkened cutout pixels, dismissal
and replay after restart. Its hidden screenshots are candidates pending matched
production references; they do not measure live FPS.

The native metronome popover is connected to serialized audio updates, project
Save/reopen and app-wide preferences. It provides click/count-in, accent, loudness,
beat-grid paint, typed/tapped tempo, half/double time, meter, bar rotation and
10 ms nudges. Ruler bar handles support snapped drag preview, release and
Alt-clear with saved corrections. Missing/stale automatic grids and explicit
Re-detect use the existing native analyzer plus the installed Beat This pack;
manual/newer grids are protected. Reusable controls remain in sibling UIKit.
No Node is involved.

```sh
# Hidden controls, both desktop sizes, persistence and fresh-process preferences;
# requires the ui-tests build:
python3 experiments/gpui-player/tests/test_native_metronome_ui.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-metronome-ui
# Engine staging, preview, live edits and count-in:
python3 experiments/gpui-player/tests/test_native_metronome.py experiments/gpui-player/target/debug/singz-gpui-audio /tmp/native-metronome
# Real callbacks, still forced silent:
python3 experiments/gpui-player/tests/test_native_metronome.py experiments/gpui-player/target/debug/singz-gpui-audio /tmp/native-metronome-hardware --hardware
# Signal-level master/click gain checks; unconditionally fake output, no hardware:
python3 experiments/gpui-player/tests/test_native_metronome_gain.py experiments/gpui-player/target/debug/singz-gpui-audio /tmp/native-metronome-gain
# Connected app-state/fault workflow using a deliberately stubbed analyzer;
# requires ui-tests:
python3 experiments/gpui-player/tests/test_native_beat_detection.py experiments/gpui-player/target/debug/singz-gpui-player /tmp/native-beat-detection
```

The real installed-model check is opt-in. It requires a percussion project with
a drums lane, its original duration, a fresh output directory, and real native
tool paths. The helpers below are debug builds: build them with
`python3 scripts/build-gpui-native.py --output-dir experiments/gpui-player/target/debug`,
because that script now defaults to `target/release`. `SINGZ_PACK_DIR` may select an existing pack; otherwise the normal
installed cache is used. This example expects a 32-second project:

```sh
SINGZ_GPUI_BEAT_REAL_PROJECT=/absolute/path/to/percussion-project \
SINGZ_GPUI_BEAT_REAL_DURATION=32 \
SINGZ_GPUI_BEAT_REAL_OUT=/tmp/native-beat-real-new \
SINGZ_GPUI_ANALYZER="$PWD/experiments/gpui-player/target/debug/singz-analyze" \
SINGZ_GPUI_AUDIO_HELPER="$PWD/experiments/gpui-player/target/debug/singz-gpui-audio" \
cargo test --offline --locked --manifest-path experiments/gpui-player/Cargo.toml beat_analysis::tests::installed_runner_real -- --ignored --exact
```

The default Rust run passes 138 tests and leaves this one ignored. The explicit
installed ONNX run passed with 65 beats at 120 BPM, ML used, no warnings and
unchanged inputs. Its output records tool/model/input hashes and the actual grid.
The connected hidden app-state check also passes: missing/stale grids, automatic
Save, protected manual/newer grids, explicit Re-detect with live corrections,
rapid grid/control intent, Save-conflict/navigation ordering, changed inputs,
cancellation, rejected-grid nonpublication and not-found retention. It uses a
stubbed analyzer for deterministic state timing and the real helper for an
anti-phase stereo RMS check; detector quality remains separate.

The UI check covers initial/grid/edited/BPM-draft controls and paused-position
invariance plus bar drag/preview/release/Alt-clear and persistence at both sizes.
Its 1060-wide flow additionally checks rejected updates, deferred Save before
navigation, same-song handoff without a second count-in,
anchor presentation and gridless/tap behavior; a fresh process checks preference
restoration. The engine checks cover bounded uploads, failed-update isolation, preview without song
playback, live swaps, variable-meter count-in and route/monitoring park retention.
The fake-only gain check verifies independent click loudness combined with app
master gain, including master zero.

Detection runs off the audio command thread, checks loaded input stamps before
and after, and fences results by project, request and manual edits. It retains
live bar corrections and updates/saves accepted audio state. Child groups and
private files are cleaned on cancellation. Missing or failed ML is diagnosed
before native fallback; no weights are downloaded during analysis. Pitch and
beat analysis remain separate processes with repeated decoding, and detailed
model progress is not yet streamed. Working-copy automatic changes remain private
until explicit Save publishes them. A chained second automatic Save guard has
code review but no separately forced end-to-end case.

New metronome screenshots are candidates pending matched production references;
hidden live FPS is unmeasured. Countdown dots, the live player BPM field, source
transitions, locale, accessibility and Windows/Linux qualification remain open. See
`NATIVE_INTEGRATION.md` and `SCREEN_PORT_STATUS.md` for coverage and limitations.

Native custom tracks now support Add/Rename/Remove, live native decoding and stable mix,
encoded-byte Save/reopen and typed unsaved handoffs through project rename. The verified
core checkpoint has 475 passing Rust tests, a hidden two-size native workflow and 84
unchanged full native frames. Final custom-only lane removal now supports native graph
release, durable empty Save/restart, Copy/Move and fresh paused re-add. The empty-project
checkpoint has 507 passing Rust tests and a hidden two-size, three-launch workflow.
Production parity and broader platform qualification remain open; see
[the custom-track review](CUSTOM_TRACK_REVIEW.md) and [empty-project review](EMPTY_PROJECT_REVIEW.md).

Native source-track export is connected to the ruler arrow through shared UIKit.
It exports selected original stems or a karaoke instruments/backing mix in MP3, WAV
or FLAC, without mixer, tempo or transpose settings. The dedicated Rust worker
uses offline native zcore encoding, cancellation and exclusive publication; existing
files and completed earlier tracks survive failure. The checkpoint passes 527 Rust
tests, real encoder tests and hidden two-size controls with 38 independently decoded
outputs; see [stem export review](STEM_EXPORT_REVIEW.md) for coverage and limits.

Carry the line now connects the footer popover to native scheduled guide ducking,
time/lyric-line grouping, actual custom-lane selection, sing-turn underlays and
project/global preferences. UI adoption and Save wait for native acceptance;
working-copy publication uses the existing queued Save/navigation lifecycle.
The checkpoint passes 557 Rust tests, actual native DSP and a hidden four-process
workflow with twenty captures, including maximum-lane scrolling and working-copy
Save/Open; all 84 prior native frames remain exact.
See [Carry integration review](CARRY_LINE_REVIEW.md) for verification and
remaining source-parity/platform gaps.

Effective BPM, native analysis progress and heard-clock count-in dots now use shared
UIKit controls. Typed rate receipts gate accepted edits/Save/navigation; monitoring
releases ownership first, and ordinary playback/mixer commands remain queued. Exact
playback command serials protect rapid toggle intent from older receipts. The verified
checkpoint passes 576 Rust tests and hidden timing/monitor/Carry/empty workflows;
35 historical full frames remain exact and 49 lyric frames differ only at the new
active BPM footer, with approved lyric-region hashes unchanged. See
[transport timing review](TRANSPORT_TIMING_REVIEW.md) for evidence and limitations.

## Native language switching

The header supports System plus all thirteen source locales, persisted by a native
worker. Source dictionaries are extracted by Rust without Node. Live language changes
preserve the current audio graph, mixer and search draft. The final two-size hidden
workflow covers all choices, keyboard/dismissal behavior, rapid changes and restart.
See [locale checkpoint and remaining translation coverage](LOCALE_PORT_REVIEW.md).

The native Log viewer chrome also follows the current language, while diagnostic
messages and copied/exported rows remain unchanged. English/Russian real Copy
checks, durable session/export regressions and all six historical native Log
fixtures pass; see [Log locale review](LOG_PORT_REVIEW.md).

The model manager and legacy engine instructions now use the source translations
for model descriptions, actions and setup prose. Hidden English/Russian install,
rollback, retry, Copy and probe workflows pass; [review and qualification limits](MODELS_LOCALE_REVIEW.md).

Linux native audio now builds through ALSA and libudev development libraries.
The current [Linux native workflow checkpoint](LINUX_NATIVE_REVIEW.md) covers
real kernel-loopback output and hidden X11 workflows; it does not qualify a Linux
release package, physical microphones, Wayland or hardware graphics. See also
[active-output Settings inventory](LINUX_SETTINGS_REVIEW.md).

Implicit native default-output changes now publish their capabilities to the
inventory worker; see the [default-route checkpoint and remaining device work](DEFAULT_ROUTE_REVIEW.md).

Raw transaction receipts now share capability intake with ordinary commands,
including owner-checked deferred facts when Copy retains the native helper.
The [reply intake checkpoint](REPLY_INVENTORY_REVIEW.md) passes 775 Rust tests
on each of Mac/Linux and 99 hidden workflow captures across 18 launches.
The subsequent [output recovery checkpoint](OUTPUT_RECOVERY_REVIEW.md) retains
documents/drafts after native transport loss, retries the exact output paused,
and adopts offline working Save without ordinary Open. It also fences Source
seek before Play and preserves rendered lyrics through publication. Final
Mac/Linux suites pass 781 Rust tests each, and 185 hidden interaction captures
across 29 launches have independent source/binary/image and retirement checks.
Physical hotplug, latest Windows deltas, full visual/temporal parity, live FPS
and release qualification remain open.

The [publication retry and Escape follow-up](PUBLICATION_RECOVERY_REVIEW.md)
verifies actual saved-metadata read failure, receipt retention, duplicate Save
refusal, exact repair/Retry and resumed native playback. Notices stay above
progress and restore editor focus; Save visibly disables through shared UIKit.
Both platforms pass 781 tests each, and 267 hidden captures across 37 launches
pass independent source/binary/state/hash checks. Healthy-live-helper publication
failure and monitor/training handoffs remain unqualified.

The [healthy live-helper follow-up](LIVE_PUBLICATION_REVIEW.md) now verifies that
ordinary unmonitored Save pauses the actual native helper even when publication
read fails. Fresh backend-owned status probes, exact repair/Retry and resumed
Play pass on Mac/VM403, with 110 final images across 14 apps and 781 Rust tests
per platform. Monitoring/training handoffs and broader release gates remain open.

The [monitoring Save follow-up](MONITOR_PUBLICATION_REVIEW.md) fixes an unwanted
Stop during working-copy Save. On Mac the same monitoring generation continues
through publication; explicit Header Stop prepares the saved project paused.
Automatic restoration and a separately labelled busy/queued-route adapter pass.
Final validation covers 157 images/20 apps and 781 Rust tests per platform.
Linux preserves its unavailable-monitor policy; its monitoring workflow and
hardware/training recovery remain unqualified.


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
