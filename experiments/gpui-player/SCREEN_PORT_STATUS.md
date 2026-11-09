# Desktop screen port inventory

The production route inventory is `src/renderer/src/App.tsx`, including lazy dialog routes.
Native backend integration has started: real project loading and native playback/mixer
controls are implemented as a first slice; see `NATIVE_INTEGRATION.md`. Full visual parity
and the remaining backend features remain separate.
Common native controls live in sibling `singz-ui/gpui`.

Empty Drive follow-up (2026-11-09): final custom-track Remove → Save → native
publication → fresh download/open → offline restart now passes at both sizes,
including truthful Pending status and preserved remote recovery media. The frozen
suite passes 943 Rust tests; six hidden launches and 14 captures pass with stable
foreground. Interrupted upload/new-Save recovery is included. See
[empty Drive review](EMPTY_DRIVE_REVIEW.md); Delete/Rename/name reuse, live Google,
platform and complete visual/performance qualification remain open.

Windows provider source checkpoint (2026-11-09): native availability, explicit
provider preferences, provider-scoped playback outputs and owner-safe switching
are implemented, with independent WASAPI input/monitor inventory preserved.
A subsequent receipt-boundary repair passes 922 Rust tests and a real macOS
graph/output/Save/restart journey. The repaired source also passes Dell builds, 865 Rust tests and the hidden
provider/restart journey; broader Windows delivery remains unqualified. ASIO remains
honestly unavailable. See [provider review](WINDOWS_PROVIDER_REVIEW.md).

Settings runtime graph follow-up (2026-11-09): accepted native playback snapshots
now provide the actual modules, bus connections and latency compensation. Shared
UIKit renders the source playback view with persistent viewport focus; native
monitoring remains the fallback when no song graph exists. Ordinary/custom graph
replacement, keyboard reading and custom Save/reopen pass a focused two-size
23-capture checkpoint. The existing Settings keyboard regression also passes;
the normal preview is rebuilt and package-verified. See [playback graph review](PLAYBACK_GRAPH_REVIEW.md) for source
identities, verified scope and remaining visual/platform/accessibility limits.

Training feedback follow-up (2026-11-09): completed-answer reveal, retained
acknowledgement and task-specific Summary copy now use native presentation and
a shared UIKit banner. Hidden EN/RU checks pass at both sizes with real native
replay/CREPE scoring. Header activation and title-pencil keyboard access are
covered. See [feedback review](TRAINING_FEEDBACK_REVIEW.md) for exact evidence
and limits; [acceptance gaps](DESKTOP_ACCEPTANCE_GAPS.md) tracks remaining work.

Song-preparation keyboard follow-up (2026-11-09): all four loaded-song recipe
choices now use shared UIKit activation and explicit focus order. The hidden
native two-size journey passes 16 checks, 16 captures and ten lifecycle receipts,
including twelve actual prepared Identify answers, Back to Song with Enter/Space,
paused source retention, native playback afterward and stale-key manual setup.
The compact six-result Summary verifies actual focus autoscroll. Setup and
exercise/history keyboard regressions pass; all 17 static native frames and six
default sidecars remain exact. See [Song keyboard review](TRAINING_SONG_KEYBOARD_REVIEW.md)
for binary scope, observer measurements and remaining parity/platform/release gates.

Training exercise keyboard follow-up (2026-11-09): shared UIKit activation now
covers native exercise/summary controls and recording; mounted focus survives
updates and removed answers/Retry recover. Progress has scoped Tab and reading
keys. The new hidden two-size journey passes 20 checks, 14 captures and 18 native
receipts across all five Identify answer layouts, Replay/Skip, pause/Continue,
Exit and actual save-error Retry. Setup and exact-WAV recording regressions pass;
all 17 static native Training frames and six default sidecars remain exact.
See [Training exercise keyboard review](TRAINING_RUNNING_KEYBOARD_REVIEW.md)
for resource measurements, preview qualification and the remaining song-preparation,
production visual/temporal, hardware, platform and release gates.

Training keyboard follow-up (2026-11-09): Home/setup keyboard navigation, shared
focusable ranges, sticky-footer autoscroll and adaptive selector placement are
implemented. Hidden native replay/scoring checks pass both sizes; 17 pointer
regression frames remain byte-exact. The later exercise checkpoint above covers
running responses and history keys; production visual parity and release remain open. See
[Training keyboard review](TRAINING_KEYBOARD_REVIEW.md) for scope and limits.

Footer keyboard follow-up (2026-11-09): ordinary transport buttons now use shared
UIKit Enter activation with song Space/arrows preserved. Split has scoped menu
keys, first-enabled focus and disabled-item recovery; output popup dismissal no
longer strands focus, and Mute/Unity/clip avoid duplicate keyup activation.
Actual hidden keyboard/restart checks pass both sizes, including real native
playback/rate/loop receipts and missing-engine Split refusal. The final combined
desktop workflow passes 52 main captures plus four motion frames, 671 resource
samples without errors, stable foreground and 50 observed processes retired.
Two prior native player images and sidecars remain exact. The normal preview is
rebuilt/package-verified. See [Footer keyboard review](FOOTER_KEYBOARD_REVIEW.md)
for fixture limits, muted native gain, high capture-run memory and remaining gates.
Training Home/setup keyboard access was completed in the later checkpoint above.

Models keyboard follow-up (2026-11-09): shared UIKit focus/activation now reaches
Get/Reinstall, GPU/CPU, Retry and Close/Skip, with modal Tab/Shift-Tab, automatic
scrolling and busy-control focus recovery. Actual hidden keyboard installation
and restart pass both sizes, preserving manual cancellation, automatic Skip,
explicit Retry, rollback and CPU persistence. Thirty-five recorded action states,
four focused captures and 129 resource samples qualify this fixture journey;
foreground remains stable and 38 observed processes retire. The normal preview
is rebuilt/package-verified. See [Models keyboard review](MODELS_KEYBOARD_REVIEW.md).
Footer transport and training setup keyboard access are the next concrete gaps;
platform/hardware, full visual/temporal parity, live FPS and release remain open.

Settings keyboard follow-up (2026-11-09): shared UIKit focus/activation and gain
keys now support modal Tab/Shift-Tab, selector commit/cancel/typeahead, checkboxes,
Close/Quick Start, automatic focus scrolling and disabled/removed focus recovery.
Actual hidden keyboard/pointer journey passes both sizes, 90 recorded keyboard
states and eight captures, with no song/file-key leakage. Four prior native pointer
images and sidecars remain exact. Normal preview is rebuilt/package-verified. See
[Settings keyboard review](SETTINGS_KEYBOARD_REVIEW.md). The later Models follow-up
above resolves the keyboard gap recorded here; platform/hardware, full
visual/temporal parity and live FPS remain open.

Desktop control fixes (2026-11-09): Settings rejects duplicate output channels,
resets channel defaults when changing devices and displays save/unavailable-channel
errors. Tap BPM resets between popup/song sessions; the trigger follows click/grid
state. Unsplit source and custom-only projects no longer expose inert Stem files
controls. Actual hidden settings, combined-player and empty/custom/source journeys
pass both sizes; all 49 approved native lyric-region records remain exact. The
normal preview is rebuilt and package-verified. See
[Desktop controls review](DESKTOP_CONTROLS_REVIEW.md) for precise scope, preserved
failures and remaining Settings keyboard, platform/hardware and parity gates.

Automatic Qwen follow-up (2026-11-09): the real no-lyrics Karaoke path now has
verified UI coverage: production LRCLIB Miss → local Qwen → automatic publication,
reopen and native playback, without manual Transcribe or Save. Both sizes and
actual Searching/Transcribing states pass six inspected captures; all 26 timed
words survive reopen. Inputs remain unchanged, foreground stable, nine observed
processes retire and nine app CPU/system-GPU samples have no errors. See
[Automatic Qwen review](NATIVE_QWEN_AUTO_REVIEW.md). Real Down/Hit UI outcomes,
full visual parity, live FPS and broader platform/hardware gates remain open.

Native Qwen runtime follow-up (2026-11-09): actual uncached recognition/alignment,
explicit editor Save, editor/player reopen and native playback pass with packaged
engines and preinstalled models. Four hidden/muted captures cover 1280×800 and
1060×640; source files/models/runtimes remain unchanged and observed processes
retire. The earlier ten-second CLI timeout was observed during Metal compilation;
a longer attempt completes, and actual app jobs pass within the existing readiness
budget. This qualifies the current host, not every fresh host. CPU/system-GPU
observations are recorded; live FPS remains unmeasured. See
[Native Qwen runtime review](NATIVE_QWEN_RUNTIME_REVIEW.md). Historical startup-gate
statements below describe their earlier checkpoints.

Mixer keyboard follow-up (2026-11-09): lane M/S, global unmute/unsolo and
Add/export headers now have persistent keyboard/pointer focus using shared UIKit
controls. Enter activates once, Space controls the song and arrows seek; disabled
resets and removed tracks recover focus. Metronome controls use persistent focus
and the shared range. Its source popup is nonmodal: Space still plays/pauses, BPM
typing owns text keys and range arrows change loudness. Half/Double limits and
unavailable controls retain a mounted focus target, preserving Space/Escape.
Actual tests exposed/fixed Enter's duplicate automatic keyup click, swallowed BPM
text and focus loss at Half's 30 BPM boundary. Final two-launch hidden/muted
combined workflow passes 44 main captures plus four timeline-motion images at
both sizes, with 36 observed helpers retired, 442 app CPU samples without errors
and unchanged foreground. Two static player frames remain pixel-identical to the
previous native checkpoint; all 49 native lyric-region records remain exact.
Normal check, UI build and focused policy/range tests pass. See
[Mixer keyboard review](MIXER_KEYBOARD_REVIEW.md). Add chooser activation, every
metronome action/state, hardware/platform and complete visual/performance
qualification remain outside this checkpoint; the native-engine startup gate
from the previous package remains unresolved.

Singing controls follow-up (2026-11-09): native lyrics now show source-style
instrumental-gap seconds and three/two/one dots, with cached stepped pulse sprites
prepared off the UI thread and bounded CPU/GPU eviction in UIKit. Pre-first-line
text stays faint until its anticipated start; the approved active glyph paint is
preserved. Song Space/arrows work while ordinary buttons hold focus; text entries,
sliders and dialogs retain their own keys, with Enter still activating buttons.
Stem faders now support actual Tab/pointer focus, accumulating arrow keys and
Home/End. Real typing exposed unconditional title key suppression; only Escape
is now consumed, leaving text insertion available to the platform input handler.
Four countdown, three keyboard-policy and one UIKit range test pass. The final
combined hidden/muted workflow passes in two independent launches at both sizes:
40 main captures plus four timeline motion images, 34 observed helpers retired,
258 app CPU samples without sampling errors, and unchanged foreground identity.
Both countdown traces observe all nine opacity levels; their sequence pass is
separate from screenshot readback so capture stalls cannot skip a one-second cue.
Six new full captures and representative restored glyph frames were inspected.
All 363 restoration images and all 49 native lyric-region hashes/draw counts
remain exact. Evidence: `/tmp/singz-singing-controls-20261109`, including the
explicit key-stamp preparation for a private copy of the older synthetic lyric
fixture. The original fixture and baselines remain immutable. This qualifies
these controls and preserved native paint, not full production parity, live FPS,
physical-device behavior or current Windows/Linux delivery. Mute/Solo button and
legacy metronome-fader keyboard reachability still need qualification. The normal
preview passes build/signing/all 39 payload hashes, Drive configuration and
crispasr startup. Llama-server help repeatedly times out on this host, including
the previous preview’s byte-identical llama-server binary; this unresolved startup
gate is preserved.

Timeline navigation follow-up (2026-11-09): lanes/ruler and pitch now share
cursor-centered Ctrl/Cmd-wheel zoom, native pinch, dominant-axis panning and
accumulated burst input with one invalidation per rendered frame. Zoomed playback
uses the source 750 ms sine page turn at the rightmost 8%; explicit offscreen
seeks cut, and manually scrolling away does not snap back. Final-page bounds
clamp each eased sample, preserving source arrival timing. A vendored pinch
filter now retains real hit testing/occlusion after keyboard input, fixing the
actual Cmd-S → pinch failure without manufacturing a mouse move.
Six pure controller tests, normal host check and UI build pass. The combined hidden/muted
workflow passes across two independent launches at both sizes: 28 main captures,
four saved motion frames, and 23 observed viewport samples per page turn.
Wheel/pitch/pinch routing, saved-view reopening, arrow/Restart cuts, intermediate
follow states and manual-away playback pass alongside prior desktop controls.
Actual Full/+/− clicks and paused-playhead captures at both sizes verify the
zoom cluster remains above the scrub layer, matching source z-order. Panned
shots capture fresh-reopen entrance states. Foreground identity stayed unchanged,
31 observed helpers retired and 101 app CPU samples had no sampling errors.
Evidence is under `/tmp/singz-timeline-20261109/ui-v3`. This establishes source behavior and runtime
interaction, not matched production pixel parity or live display cadence.

Desktop controls follow-up (2026-11-09): Restart alternates selection/song start,
retains that cycle through a playing-song rename, and honors a catalog Pause
during rename. Native callback command tickets now acknowledge actual command
application, including a one-frame region that starts and finishes in one callback;
rejected queue admission cannot cancel an accepted request, and cancelled I/O
failures retire the reply stream. Five focused Rust playback tests, normal host
check, focused region tests and the full native playback-session suite pass.
The shared Song output popup adds the source dB range, half-dB steps, mute restore,
unity reset and native peak/clip telemetry. Catalog entry rescans external changes;
cards/delete confirmations support Tab/Shift-Tab and Enter, with focus recovery
when a row disappears. The final combined hidden/muted workflow passes in two
independent launches at both desktop sizes (20 captures), including Save/reopen,
region boundaries, Karaoke preferences, output controls and catalog actions.
Four output/catalog captures were inspected. Foreground identity stayed unchanged;
25 observed helpers retired and 68 app CPU samples had no sampling errors.
Evidence: `/tmp/singz-controls-20261109/ui-v3/{source,result}.json` and stage
receipts/captures. Runtime clipping under a nonzero signal, live FPS, matched
production visual parity and platform/hardware qualification remain unproven.

Draft follow-up (2026-11-09): the combined hidden graph workflow now passes in
two independent launches with twelve captures. Karaoke defaults off, persists
through the existing preference worker, restores on with an initially enabled
guide muted by the actual native lane command, and persists off through Escape.
Songs/catalog navigation pauses native playback and retains catalog state through
Training. Region creation, both-edge resizing, click/Escape clearing, actual native
non-loop end stopping and loop wrapping, and Save/reopen of selected/cleared
regions pass at both desktop sizes. All four region captures were inspected;
foreground identity stayed unchanged and all nine observed helpers retired.
Three gesture tests, five project-store tests, focused native region tests, the
full native playback-session suite, five preference tests and five focused
Karaoke tests pass. Source review also fixed queued-preference loss at Quit,
independent preference-write failures, and guide remuting on same-song handoffs.
The latter lifecycle cases have scoped unit/source evidence, rather than a new
physical-device or full visual-parity claim. Live FPS remains unmeasured. This
is an in-progress migration draft, not a completed parity or release checkpoint.

Completion audit (2026-11-09): the real native footer now reveals the vocal file
through “Stem files”, and opening Karaoke mutes the guide vocal unless Carry is
armed, matching the source. Closing Karaoke leaves mute unchanged. The normal
build and focused source review pass; external file-manager presentation was not
invoked during background verification. The refreshed `macos-current-clean`
preview passes deep strict signing, all 38 payload hashes and both bundled lyric
CLI startup checks. Fresh staging avoids inheriting source download metadata;
the original installed app and OS security settings are untouched. Prioritize
remaining functional gaps and actual delivery over more recovery matrices.

Completion focus (2026-11-08): no confirmed absent major desktop screen remains.
Prioritize complete user journeys over more recovery matrices or capture archives:
released model download → real split → Save/reopen; real lyrics lookup/alignment
→ Save/play; physical microphone permission → training/recording → WAV save.
The first journey now passes on Mac with an empty private model cache and the
actual released ARM pack: real seven-lane inference, explicit Save, legacy FLAC
vocal separation, reopening the saved project, and muted native playback. All
eight captured screens were inspected; foreground identity stayed unchanged in
1,143 samples and four observed app/helper/inference identities retired. Input
was a two-second generated tone, so this proves the connected runtime lifecycle,
not general-song separation quality, long-song behavior or other platforms.
The real Precise editor journey also passes on Mac: actual optional ONNX model
consent/download, CTC inference, 26 finite word timings, no preview publication,
explicit Save, editor/project reopen and muted native playback. All three
screens were inspected; foreground stayed unchanged across 1,136 samples and
four observed app/helper/downloader/aligner identities retired. This uses a
9.015-second spoken fixture, not a singing-quality benchmark. Live LRCLIB
availability/schema was checked separately. Connected production LRCLIB search
and selection now also pass on a public-domain 141.546-second Frank C. Stanley
recording: exact candidate 12618083 is immediately published, then real Precise
inference generates 111 timed words, explicit editor Save and both reopens
preserve them, and muted native playback succeeds. The longer input exposed
editor drafts being rebuilt from f32 playback timestamps. Drafts now use the
accepted f64 saved snapshot; all 10 parser tests and the unchanged end-to-end
comparison pass. The historical full mix produced six interpolated lines
(73% words heard); this is integration coverage, not perfect timing quality.
Physical microphone training/recording and actual OS chooser presentation remain open.
The real full-song capture also exposed missing source pitch-label collision
rules. Native bars now shift/omit colliding labels using the source's 5px rule;
frame labels use its 34px extent/30px spacing conditions, with matching font
sizing and top-lane placement. Both modes were inspected at both desktop sizes
after a native paused seek to zero; this is source-behavior verification, not a
new claim of complete pixel parity or live display cadence.
All seven current shipping model URLs respond successfully; local Precise weights
are absent, so that journey must include the actual optional model download.
The default codec gap is now fixed and real Mac/Linux helper format checks pass;
Windows codec delivery and remote baked Drive configuration remain pending.
See [delivery follow-up](DESKTOP_PACKAGING.md#codec-and-drive-delivery-follow-up).

| Production surface | Native state | Next work |
| --- | --- | --- |
| Songs/catalog (`DropScreen`) | Interactive fixture port and native project catalog; authoritative directory-based inspected delete confirmation, root/writer/conflict guards, reversible hide and durable deleted-intent commit, loaded-song stop/clear with paused failure recovery and unrelated playback continuity | Deletion unit checkpoint: 422 passed, 0 failed, 2 ignored. Final UI v6 passes both sizes (12 PNGs/four actual deletions), advancing unrelated native playback, paused conflict recovery, writer refusal and loaded clear/no resurrection; independent filesystem/ledger seq4/dirs4 checks pass. Real intrinsic/shrink-0/min68 grid plus outer scrolling fixes 1060 reachability; demo fixture branch unchanged. 84 final full native frames remain exact; strict diffs, picker/import regressions, final unit/build logs and source/font recovery identities are archived; [review](PROJECT_DELETE_REVIEW.md). Live/platform Drive qualification, matched production references, platform qualification and strict visual/control matrix remain open |
| Player, mixer, transport, pitch and lyrics | Interactive fixture port with approved native lyric layers; real project playback/mixer, saved lyrics/pitch, tempo/transpose and Save connected | Saved format-1 graphs now reach the shared native engine with hash-checked loading and preserved raw bytes; native DSP gain/rebuild/handoff checks and full 765-test suite pass. [Graph checkpoint](NATIVE_GRAPH_REVIEW.md). Remaining backend features; finish typography/control matrix |
| Audio open and split workflow | Native picker/drop/CLI opening, unsaved working copies, three split modes through resolved system Demucs or the existing model pack, seventh backing lane, nonmodal inline split progress with playback/transport handoff, native FLAC Save, conflict-safe in-place publication; hidden fault and real ONNX/UVR pipeline checks | Source loading/progress parity and easing, discard/recovery UI, full format/long-song and platform qualification |
| Custom audio tracks | Native saved custom inventory, Add/Rename/Remove, stable IDs/colors/encoded files, sixteen active lanes, real atomic native replacement and typed dirty handoffs; transactional Save/pruning and re-split preservation | Core checkpoint: 475 Rust tests, real helper/DSP suite and hidden two-size v9 workflow pass; unsaved Add and Remove survive actual project rename, source hashes remain exact, loop/pitch/focus preserved. Existing title/import/deletion regressions and 84 strict native frames pass. [Review](CUSTOM_TRACK_REVIEW.md). Final custom-only removal, durable empty Save/restart, empty/custom-bearing Copy/Move and fresh paused re-add now pass a separate 507-test/three-launch hidden checkpoint; [review](EMPTY_PROJECT_REVIEW.md). Full inference E2E, codecs/long songs, chooser, production visual/temporal parity and platforms remain open |
| Stem export (`StemExport`) | Shared UIKit modal, all/selected separate source tracks or karaoke instruments/backing mix, MP3/WAV/FLAC, native folder workflow and cancellable offline zcore worker; original source audio without mixer/tempo/transpose, sequential exclusive publication and retained completed outputs | 527 Rust tests, real native encoder/mix/cancellation tests and hidden two-size v4 controls pass with 20 captures/38 independently decoded outputs. Long-label wrapping, scroll/focus, empty selection, folder cancellation, collisions and busy cancel/reopen fences verified; [review](STEM_EXPORT_REVIEW.md). Production-matched visual/temporal references, live playback under export, actual folder chooser, long songs, device/platform qualification remain open |
| Audio settings (`SettingsModal`) | Real native inventory/output selection, persisted route, native input/channel capture, live meters and experimental monitoring with playback output handoff, persistent owner badge/Stop outside Settings and paused restoration; fixture modal retained | Native transport-loss retention/retry and offline working Save adoption now pass the [781-test Mac/Linux recovery checkpoint](OUTPUT_RECOVERY_REVIEW.md), with 185 hidden interaction captures/29 launches including Source seek fencing and visible lyric retention. Physical hotplug, training/monitoring recovery, latest Windows deltas and visual states remain open |
| Log (`LogPanel`) | Native modal with source-key localized chrome, real worker events, durable per-launch sessions, latest-4000 live ring, past tail/full count, local-time Copy and full-past/current-ring Save; bounded writes/rotation, safe destination publication and async selection/session fences | Locale follow-up: final 747 Rust tests pass (2 ignored), 59 locale captures including EN/RU Log Copy, 32 diagnostics captures and 6/6 exact historical Log fixtures; [current review](LOG_PORT_REVIEW.md). Earlier diagnostics checkpoint: 359 Rust tests pass (2 ignored); final hidden UI v6 passes with 32 two-size seed/review/short-launch PNGs, including UTF-16/long rows, body shrink, fresh session inventory, Copy/follow-scroll/full Save and receipt races; model/source/engine-setup/sidebar regressions and normal build pass; 84/84 strict native frames and 6/6 historical native Log fixtures remain identical. See [completed diagnostics review](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-diagnostics-20261107/REVIEW.md). Earlier empty/rows production comparisons still differ; actual native save-dialog presentation, temporal/locale/accessibility and platform qualification remain open; Windows descendant cleanup is not qualified |
| Vocal training (`VocalTraining`, `VocalTrainingRoute`) | Home, seven setup routes, programs and empty/filled Progress ported; native Test C4 and Start with shared native cues, exclusive CREPE input, live hold/scoring, running/summary UI, restart, identification and guided next-note scheduling; hidden lifecycle checks; shared controls/fonts; durable setup/receipts/history, calendar-based program credit and loaded-song preparation with paused return; training-only owner-4 raw microphone samples, 30-second cap, retained native WAV, stop/navigation finalization, permanent detached-receipt fence and worker Save WAV export | Recording checkpoint: 390 normal Rust tests pass (0 failed, 2 ignored) and native helper build passes; UI-feature build v2 and hidden two-size driver pass (12 PNGs/6 WAVs), native input v2 raw 8 kHz/30-second-cap and prior input/microphone/monitor regressions pass; source compact-height overlap fix inspected at both sizes. Final unit suite (390 passed), normal build, training-run and 8 comparator self-checks pass; 84/84 full native frames strictly identical after matching app-local pointer hover state. See [training recording review](TRAINING_RECORDING_REVIEW.md) and [completed checkpoint archive](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-training-recording-20261107/REVIEW.md). Actual hardware/permission/chooser presentation, Windows/Linux, full task/state coverage, active-session restoration, general song recording scope unresolved (no current production screen), source animations, setup-first source-checkout discrepancy and strict visual/audio parity remain unqualified |
| Legacy engine instructions (`SetupModal`) | Native source-key localized instructions/actions, command selection/copy, GitHub link, source dismissal and keyboard focus; conditional failed-engine route; independent native recheck with generation/session and probe-start freshness fences; system-first discovery and actual resolved-system Split | 338 Rust tests and final hidden UI v4 pass, including both stale-probe orders, clipboard telemetry and failed-startup recovery; all 84 existing frames remain exact. Evidence is archived in gpui-engine-setup-20261107; matched production captures, locale/accessibility and Windows/Linux qualification remain open. Normal exhausted discovery reports missing models and opens the model manager, as in the source |
| AI model manager / first-run setup (`SetupWizard`) | Native source-key localized inventory/labels, progress, Get/Reinstall, retry, persistent modal, manual cancellation and automatic Skip; Rust curl/tar worker with recoverable publication; Windows GPU/CPU preference; hidden local HTTP/install/restart checks; execution probe connects engine readiness | English/Russian installer/setup flows pass 52 captures; all 7 English model-manager frames match the immediately preceding native build, while 19 setup full frames differ. 747 Rust tests and normal/UI builds pass; [locale review](MODELS_LOCALE_REVIEW.md). Matching production captures, native-only messages, contextual model notices, progress easing and remote release-asset qualification remain open |
| Lyrics sidebar / version picker | Native tag/filename metadata and LRCLIB lookup ladder, inline search/candidate selection, source/credit and conditional actions, speech/model consent, transcription, Check & align/Precise, cancellation and mismatch feedback; fingerprint-checked publication and coordinated editor/Save/split handoffs; durable local sync-intent marks | Final hidden muted two-size protocol/publication and coordinated workflow regressions pass; archived in `gpui-lyrics-sidebar-20261107/REVIEW.md`; separate real Qwen speech-fixture receipt passes; live LRCLIB qualification, general singing quality, actual Precise weights, matched production/temporal captures, locale/accessibility and Windows/Linux qualification remain open; dirty ledger now feeds the native Drive service; its qualification remains open |
| Lyrics editor (`LyricsEditor`) | Native source-key localized draft rows, toolbar, replacement/help, consent, placeholders, plural hints/verdicts, split/merge/add/remove/stamp, undo, envelope/word strip, conflict-safe independent Save and working-copy publication; editor alignment stays a preview until Save; connected Qwen/Precise runners and model consent/download/cancel | English/Russian editor and alignment workflows pass 80 captures at both sizes, including compact help scrolling and visible keyboard confirmation; 748 Rust tests and normal/UI builds pass. [Locale review](LYRICS_EDITOR_LOCALE_REVIEW.md). Real Qwen speech-fixture cold/warm checks passed separately; real Precise weights, general singing quality, production visual/temporal parity, all-locale/accessibility and Windows/Linux integration remain open |
| Projects/storage (`ProjectPicker`) | Native project rows/badges/dates, empty/loading states, Browse/Open/Close, keyboard trap/scroll, persisted library root, detected cloud folders, copy-only relocation/reset with collision preservation and native writer leases; source-backed UIKit modal and entrance animation | Hidden two-size/four-process UI, copy integrity and restart/reset checks pass; Live/platform Google Drive qualification, matching production captures, locale/accessibility, folder-dialog/platform qualification remain open |
| Library import (`LibraryImport`) | Native source-backed Copy/Move modal, busy dismissal guard, external-project header entry, nonblocking success toast, safe exclusive publication and real Move/EXDEV fallback; project/lyrics conflict checks, captured-root destination, native playback/mix handoff and post-import Save; hidden two-size controls/continuity/stale-receipt checks pass | Production-matched dialog/toast/animation captures, actual cross-volume/platform UI qualification, locale/accessibility and live Drive qualification remain open; source has no Cancel/progress controls during import |
| Quick start (`QuickStart`) | Native welcome and contextual Library/Player tour with source English/Russian copy (English fallback elsewhere), shared UIKit cutout/balloon/buttons, Back/Next/Done, keyboard trap, Help/Settings replay and durable dismissal; hidden two-size checks | Matched production captures, hover transitions, locale, accessibility/focus-return parity and normal first-run/platform qualification |
| Release highlights (`WhatsNew`) | Native version-link modal with bundled source content/icons/Telegram art, scrolling, keyboard focus and dismissal; worker-owned monotonic seen state, fresh-install baseline, skipped-release collection, downgrade protection and startup/Quick start ordering | Matched production and entrance/hover/focus captures, full translation/layout qualification, accessibility, playback-under-modal and packaged/Windows/Linux qualification remain open |
| Song/project title editing | Native inline input with Enter/Escape/outside-click commit; saved folders rename in their current parent with collision/conflict checks; working split Save destination reanchors; mixer/playback handoff and library search focus retained through reopen | Matched production visual captures, narrow-header behavior, success notices and platform qualification |
| Google Drive account/sync | Independent native OAuth/HTTP worker, durable dirty scheduler, verified immutable upload spools, metadata/catalog-last reconciliation, published-phone adoption and shared UIKit account/status controls | 723 Rust tests pass (0 failed, 2 ignored), including actual local OAuth/HTTP, expiry/cancellation and ledger recovery. Final hidden two-size/restart Drive UI v6 passes (22 PNGs), as do timing/monitor/Carry/empty/picker regressions and all 84 strict prior native frames. Live FPS remains unmeasured. Streaming download bytes/speed now reach adoption before EOF; 105 focused Drive tests and 22 hidden writer regression captures pass, while full-suite engine-probe failures recur. [Progress follow-up](DRIVE_PROGRESS_REVIEW.md). The combined local streaming/cancel/resume/adopted-playback/Save/offline workflow now passes: 753 Rust tests and 56 captures across five hidden app processes, including writer/deletion regressions. [Adoption review](DRIVE_ADOPTION_REVIEW.md). Darwin accepted-socket mode is fixed in the HTTP fixture and OAuth callback; independent engine startup timeouts remain unresolved. Malformed/unsafe ledger errors now retain a responsive worker and recover after external repair plus explicit retry; 108 Drive and 10 scheduler tests pass. Latest full suite: 755 passed, one recurring engine timeout, two ignored. [Recovery review](DRIVE_RECOVERY_REVIEW.md). Portable graph UTF-16 name/key validation and exact raw HTTP publication now pass 114 focused Drive tests; the final full suite passes 762 tests (two ignored), without resolving earlier intermittent engine timeouts. [Graph review](DRIVE_GRAPH_REVIEW.md). Native-empty compatibility, live Google/platform/packaging and production visual comparisons remain open; [review](DRIVE_PORT_REVIEW.md) |
| Language menu, help, confirmations | Native System + 13 locales, shared popup/flags, persisted worker selection and live source-key updates; keyboard navigation, focus return, EN/RU help/release fallback and restart verified | 747 Rust tests pass in five consecutive runs; final hidden two-size locale driver passes 47 captures, plus eleven workflow drivers and dedicated empty-project Save/focus regression. All 49 approved lyric paint frames remain exact; 25/84 historical full frames exact, 59 source-copy differences preserved. Metronome/Carry follow-up adds localized controls and 55-capture locale flow; current full suite has one recurring engine-probe timeout (isolated 10-test subset passes). Remaining screen/native-only localization, production visual/temporal/accessibility and platform qualification; [review](LOCALE_PORT_REVIEW.md) |
| Metronome | Native popover with shared UIKit controls and source-key localized labels/captions; serialized accepted-state updates, click/count-in, loudness/accent, typed/tapped tempo, half/double time, meter/nudge/rotation, cached beat-grid paint, draggable/Alt-clear ruler bar corrections, saved grids and global preferences; cancellable native automatic detection/Re-detect with installed Beat This, stamp/mutation guards and native fallback diagnostics; mid-song/gridless count-in with fixed song-position anchor; coordinated song/click master gain; hidden two-size bar/control checks, connected detector app-state/fault checks, restart/native signal checks and an explicit real installed-model pass | Combined pitch/beat decode optimization, detailed model progress, chained second automatic Save E2E, source transitions, locale/accessibility, matched production captures and Windows/Linux qualification |
| Effective BPM / count-in / analysis | Source-backed shared UIKit BPM input and ±1 steps, actual native analysis progress, heard-clock grouped count-in dots, accepted/coalesced rate changes, monitor release and serial-acknowledged fast controls; queued Save/navigation and independent restart | 576 Rust tests, native signal suites and final hidden timing v15 (57 PNGs/both sizes), monitor handoff, Carry/empty regressions and normal/UI builds pass. Historical full frames: 35/84 exact; 49 differ only in new active BPM footer, while all 49 approved lyric-region frames remain exact. See [timing review](TRANSPORT_TIMING_REVIEW.md). Matched production/temporal captures, locale/accessibility, live FPS and hardware/platform qualification remain open |
| Carry the line (`TrainPopover`) | Native shared UIKit source-key localized time/lyric-line settings/captions and guide selection; transactional scheduled native ducking, accepted receipt/status fences, sing-turn lyric underlays, project/global preferences and coordinated Save/Open | 557 Rust tests, actual native DSP v4 and hidden four-process v11 UI pass with 20 captures, both sizes, sixteen long-label keyboard scrolling, actual receipt-gated Save/Open, working publication and restart. Empty-project/export regressions, normal build and all 84 strict native frames pass; [review](CARRY_LINE_REVIEW.md). Matched production references, full temporal/locale/accessibility/hardware and Windows/Linux qualification remain open |

Checkpoint commits: SingZ `a5054e4e`, shared UIKit `3075c57`. They establish a reviewed
prototype baseline, not a completed interface or production integration milestone.

Do not remove the approved native highlight to make an Electron screenshot diff smaller.
Follow `LYRICS_HIGHLIGHT_STANDARD.md` and the interface-port-review skill. Capture all checks
hidden and muted; missing captures and unmeasured live FPS remain explicitly unresolved.

The [Dell native filesystem follow-up](WINDOWS_FILESYSTEM_REVIEW.md) now passes
718 Windows tests and a fresh combined 52-image graph/Drive/adoption batch; the
current Mac suite passes 770 tests. This qualifies those listed workflows only.
The remaining Windows UI/hardware scenarios, Linux integration, production visual
and temporal parity, accessibility and packaging remain open. The recurring Mac
engine-probe timeout is not closed by a later passing run.

The [Windows workflow follow-up](WINDOWS_WORKFLOW_REVIEW.md) adds per-case passes
for Unicode header rename, library Copy/Move, project deletion and training
recording/WAV export: 41 captures on the current Windows UI binary. Recording
uses native PCM replay, and chooser selection is intercepted; physical microphone
and OS dialog presentation remain unqualified. The inspected narrow title editor
and Open label still clip. The runtime13 host's external focus interruption is
retained; runtime14 deletion/recording retry passes with focus unchanged.

The [header layout follow-up](HEADER_LAYOUT_REVIEW.md) closes the observed narrow
title-field border clipping and Open-label final-letter loss. Mac and Dell title
workflows plus the Mac locale workflow pass with 71 captures and unchanged focus.
A strict native before/after comparison confines all 1,212 changed pixels to those
two header regions. This is defect evidence, not a production parity claim.

The [Linux native integration follow-up](LINUX_NATIVE_REVIEW.md) restores the
shared ALSA playback/capture provider omitted from this checkout. Six Mac and seven Linux native
regression suites pass; full Rust suites pass 770 tests on each. Actual kernel
underrun recovery is verified, and the recovered-binary private-display UI batch
passes 101 captures across eight runs/twelve app processes: title, graph/Save/restart,
Copy/Move, deletion, Drive/adoption, recording/export and repeated graph playback.
All PNG/binary hashes, process counts, unmapped-window records and foreground
samples pass an independent archive check. Physical microphones/choosers, live
services, hardware GPU/Wayland, visual/temporal parity and packaging remain open.


The [active-output Settings checkpoint](LINUX_SETTINGS_REVIEW.md) fixes fresh
ALSA inventory losing the application's playing output. Proven in-memory facts
are reused only for explicitly busy, still-present endpoints; IDs remain opaque,
removed endpoints are evicted and native admission stays authoritative. Final
Mac/Linux Rust suites pass 771 tests each; six Mac/seven Linux native suites pass.
Three-launch Settings checks pass with 16 Mac and 13 Linux captures, plus eight
final Linux graph captures and actual kernel busy-metadata/underrun recovery.
Foreground and native process retirement are verified; task containers are stopped.
Hardware/hotplug, production parity, live FPS/GPU, accessibility and packaging remain open.

The [default-route follow-up](DEFAULT_ROUTE_REVIEW.md) closes the reproduced
missing capability snapshot on implicit Play/preview/training default changes.
Simulated 48→44.1→48 kHz churn and explicit-route retention pass on both platforms;
45 hidden Settings/graph captures and corrected non-empty Mac process observation
pass. Rust suites remain 771 passes each, with six/seven native suites and actual
kernel underrun recovery. Raw transaction snapshot intake, device-loss document
retention and hardware qualification remain required; this is not full route recovery.

The [reply intake follow-up](REPLY_INVENTORY_REVIEW.md) now admits capability
snapshots from raw transactions as well as ordinary commands. A retained Copy
helper can promote deferred facts only after its new owner confirms the same
output, without evicting or overwriting newer inventory facts. Final Mac/Linux
Rust suites pass 775 tests each (two ignored); four hidden workflows per platform
pass 99 captures across 18 app launches, with independent source/binary/image,
foreground and process-retirement checks. The normal Mac build is restored and
the two isolated Linux containers are stopped. Runtime device-loss document
retention/retry, hardware, visual/temporal parity and release gates remain open.


Current output recovery follow-up: runtime native failure now retains the loaded
document, accepted edits and stopped clock; Settings Retry reprepares paused
without ordinary Open. Working Save adopts the exact published metadata hash,
preserves editor/lyrics/sidebar state and stays offline until explicit Retry when
already failed. Source handoff waits for actual paused seek before Play. Final
Mac/Linux suites pass 781 tests each; 185 hidden captures/29 launches and source,
binary, image, persistence, foreground and owner-retirement checks pass. Both task
containers are stopped and the normal Mac build is restored. See
[scope, preserved failures and remaining gates](OUTPUT_RECOVERY_REVIEW.md).

The [publication retry/notice follow-up](PUBLICATION_RECOVERY_REVIEW.md) now
passes the real metadata-read fault, duplicate Save, exact repair/Retry, repeated
Escape, notice/editor focus and visible disabled-Save cases on Mac and VM403.
Final suites pass 781 tests per platform; 267 hidden captures/37 app launches
have independent source/binary/state/hash/retirement checks. The full desktop
objective, production visual matrix, live FPS, latest Windows and hardware/service
qualification remain open. Healthy-live-helper publication failure and
monitor/training recovery are still untested.

The subsequent [live-helper qualification](LIVE_PUBLICATION_REVIEW.md) closes the
ordinary healthy unmonitored publication-failure case: direct fresh native
status proves the retained helper paused, with exact repair, paused replacement
and actual Play advancement. Both platforms pass 781 Rust tests; 110 final
images/14 apps are independently checked. Monitor/training recovery remains open.

The [monitoring Save checkpoint](MONITOR_PUBLICATION_REVIEW.md) fixes working
publication interrupting monitoring and premature lease-conflicting preparation.
Mac monitoring generation continuity, automatic paused Header Stop restoration
and a labelled held-busy route-intent adapter pass, alongside native regressions.
Final evidence is 157 images/20 apps, 781 tests per platform. Linux monitoring
remains unavailable by source policy; its disabled UI is checked. Actual devices,
training recovery and the remaining visual/platform/release gates stay open.
Fifteen legacy Mac frames have an 801-logical-pixel initial height and are not an
exact 800-high parity contract. Physical hotplug, latest Windows, the full visual
and temporal matrix, live FPS and release qualification remain open.


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

Native desktop Drive browse/download/offline-open has a separate verified reader
cache outside the writer library. The hidden two-size online/fresh-offline
journey passes 29 captures with actual search, cancellation, hash-corruption
refusal, Retry and native playback of stem-only/saved-graph copies. Strict empty
data is a reader fixture; native empty publication remains refused for older
reader compatibility. The normal macOS preview is refreshed and passes signature,
39-payload, no-Node and configured-Drive checks. See
[Drive restore review](DRIVE_RESTORE_REVIEW.md) for binary identities, preserved
failures and exact scope. The current Library focus-repair source passes 909 Rust
tests with zero failures and two installed-model ignores. An earlier run had one
intermittent engine-probe failure; the passing run does not close its cause.
Production parity, Windows/Linux and
hardware qualification, accessibility and live FPS remain open.


The [native macOS package checkpoint](MACOS_PACKAGE_REVIEW.md) adds a maintained
standalone `.app` assembler with native dependency/architecture/minimum-OS checks,
exclusive publication, OFL notices and optional ad-hoc signing. Native helpers load
bundled CREPE/training data from Resources while loose runtimes remain adjacent.
The current arm64/macOS-26 local preview passes 23 assembler tests, the 808-test
Rust suite, actual signatures/relocation, muted native training, normal hidden
startup and 29-image/four-app clean-environment functional checks. This is local
preview verification; notarization, older systems/universal and other-platform
packaging, real hardware/services and full parity/release gates remain open.
