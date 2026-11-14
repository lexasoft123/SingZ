# ADR 0016: The recorded take is a playback lane

Status: proposed<br>
Date: 2026-11-13<br>
Supersedes (when accepted): ADR 0014 rule "plays back as sung, with the settings
it was recorded under" and its milestone 1 rate-1 output-mix playback; spec R3,
VS-PLAY-001/002/003/006, the `playing-take` state and the listen-back part of
VS-TAKE-005.

## Owner decision (final, input)

The take becomes a lane, like a stem, and plays whenever the transport plays.
The Voice lane's Solo hears it alone, Mute silences it. "Listen" and "Listen
with song" are removed.

## Question

A take was sung against a recorded tempo/transpose timeline that may change
mid-take. How does the lane stay locked to the song's musical timeline under any
current tempo (0.25..4) and transpose (±24), and what do Solo and Mute mean on a
lane that also has a live monitor?

## Facts read in this checkout

- Tempo is structural: all sources are read at one prepared Q32 rate `R`
  (`rateToQ32`, `native_playback_session.cpp:69-77`); one song-bus Signalsmith
  node shifts pitch by `transpose - 12*log2(R)` (`desktop-native-playback.ts:201`).
  A change rebuilds the generation, seamed on the running stream.
- That node's seek, loop and count-in anchors are the session's most fragile
  code ("one refusal is terminal for the session", `signalsmith_time_pitch.h`).
- A lane source has no start offset; lanes enter at project frame 0. Unequal
  lengths are allowed and the longest lane sets the song duration (`:2753`).
- Bounds: 16 lanes (= zdsp `kMaximumBusesPerProcessor`), 128 nodes, 3 per lane.
  Lane mute/solo/gain are callback-domain (`setLaneControl`), no rebuild.
- Listen-back today is outside the graph: `TrainingPcmMixer::renderTake` reads
  the WAV at rate 1 at the shared output mix, anchored to the render head by
  `TakePresentationProvider` ("no latency subtraction"), using only
  `settings[0].tempo`. The renderer (`audio/voice-take.ts` `listen`,
  `replayTimeline`) sets the SONG to the take's settings on a wall-clock timer
  and mutes stems itself for solo (`MUTED_BY_SOLO`).
- Placement is already in the project domain: `recordPlacement` looks up
  `C - I - O - G` in the presentation history; `startPositionSec` is song
  seconds; the move adds `userOffsetSec`.
- The sidecar timeline is coarse: `atSec` is the main-process wall clock since
  `createdAt` (`voice-takes.ts:301`), not capture samples.
- Capture is microphone only; no output loopback reaches the take writer.
- Streamed lanes are the default on macOS and Windows; decoded-lane adoption is
  all-or-nothing on the lane set (`NATIVE-PLAYBACK-BRIDGE.md`).
- `native/playback/*` and `src/shared/*` are shared with the phones and Box.

## Model

Take time `t`, project time `p` (song seconds at tempo 1). The recording defines
a piecewise-linear `p = P(t)` with slope `Tr_i` (recorded tempo of segment i),
`P(0) = startPositionSec`; segment i was sung in key `Xr_i`. Current song: `R`, `X`.

**Conformed take `C`**: each segment time-stretched (pitch kept) to `d_i * Tr_i`
and pitch-shifted by `-Xr_i`. `C` depends only on the take and its recorded
timeline, never on `R` or `X`. As an ordinary lane it is read at `R` and the bus
shifts by `X - 12*log2(R)`: the voice is heard at `X - Xr` relative to how it
was sung, exactly on the song timeline at any tempo. For a take recorded at
100% / 0 st, `C` is the take itself (no DSP).

## Options

| Option | For | Against |
|---|---|---|
| (a) Lane with its own real-time time map and a second Signalsmith node | One processing stage, best quality | Sources share one rate; ratio would change in the callback mid-take; a second node needs its own seek/loop/count-in anchors and latency compensation; time-pitch CPU and memory double. Multiplies the highest-risk code. **Rejected** |
| (b) Offline conform to the project domain, then an ordinary lane | No real-time session change; sync with seek, A-B loop, count-in, pause and seams is the stems' own; same graph and device latency as placement assumed; callback cost is one more lane; one render per take | A cached file per take; a stretched take passes two time-pitch stages (offline, then the bus) even at its recorded settings, so "as sung" is exact only for takes recorded at 100% / 0 st; a move rewrites the placed file. **Recommended** |
| (b') Conform per current settings | One processing stage | A render of seconds on every tempo nudge, a cache per setting. Rejected |
| (c) Keep the separate take host on the transport clock | Little new code | Needs its own real-time stretch, its own graph-latency compensation (about 150 ms when the bus node is active) and its own solo bookkeeping; it is the model the owner removed. Rejected |
| (d) Always "Add to song as track" | Reuses stems fully | Moves voice into project save and sync (VS-STORE-005). Stays the explicit M3 action. Rejected as default |

## Decision

1. **Option (b).** The lane `voice:take` is a transient lane added by the engine
   at prepare; never written to the project, the graph document or sync.
2. **Placement is baked into the file** (v1): `placed = silence(start) + C`,
   `start = startPositionSec + userOffsetSec`, head trimmed below 0, tail trimmed
   at the song duration so the lane never lengthens the song. A native per-lane
   `startProjectFrame` is a later optimisation only if WP0/WP3 measure the move
   as too slow.
3. **Pitch follows the song key** (voice shifted by `X - Xr`). At sung pitch over
   a transposed song the lane is out of key and useless. Beyond ±3 st the clip
   tag adds "voice shifted" (it will sound artificial).
4. **Sample-accurate timeline.** Additive sidecar field
   `anchors: [{ takeFrame, projectFrame }]` (version stays 1), written at the
   first sample, after each settings change lands and every 2 s, from the same
   `presentationQuery` placement uses. Conform uses anchors when present (they
   also absorb capture/output clock drift); old takes fall back to
   `settings[].atSec` and are tagged approximate when `settingsChanged`.
5. **Cache.** Body keyed by (take identity, anchors/settings hash, conform
   version); the placed file adds the start frame. Stored beside the take,
   outside the project, written temp-then-rename, removed with the take, rebuilt
   on a miss. Clip peaks keep coming from the raw take.
6. **Live updates.** Drag shows the ghost only; on drop, new take, discard or
   active-take change: rewrite the placed file, then one prepare seamed on the
   running stream (plain rebuild when paused). Mute/solo/level: `setLaneControl`.
7. **Recording.** While a take records, the existing take lane is forced silent
   by `setLaneControl` and restored on stop; no voice-lane rebuild is issued
   during recording; the new take enters the lane after it is finalized and
   conformed. Nothing electrical can feed back (capture is mic-only); the rule
   removes acoustic bleed and a doubled voice. Placement and the presentation
   history are untouched.
8. **One lane, one active take.** With the M3 takes list, one take per song is
   active; choosing another swaps the source. Takes never replace one another:
   every recording is kept and stacks in the strip, one row per take, newest on
   top (DAW convention); the selected take is the active, audible one (a new
   recording is selected), chosen by clicking its block. Delete acts on the
   selected take and the newest remaining take becomes active (spec VS-TAKE-7). Later comping renders several
   takes into one placed file; the lane count stays 1.
9. **Lane budget.** The take uses 1 of 16 lanes, 3 of 128 nodes. On a 16-stem
   song the engine omits the take lane and the clip says why; the song is never
   declined because of the take.
10. **Removed:** `playTake`/`stopTake`, `TakeStream`/`renderTake`,
    `TakePresentationProvider`, IPC `voice:play`/`voice:stop-play`,
    `VoicePlayTakeRequest`, the renderer `listen` machinery and its i18n keys.

### Solo and Mute

- **M and S act on the recorded take only**, with the stems' semantics and the
  same native solo group: Voice Solo silences un-soloed stems; a stem's Solo
  silences the take unless Voice is soloed too.
- **The live monitor obeys only the Speaker button.** It is never silenced by M,
  by another lane's Solo or by the recording rule (separate host; "solo-safe"
  like DAW input monitoring). Voice Solo with Speaker on gives take plus live
  voice, the outcome VS-PLAY-006 asked for.
- M and S are disabled, with the reason as tooltip, while the lane has no
  playable take (a soloed empty lane would silence the song).
- Fader unchanged: monitor level while Speaker is on, take level otherwise.
  M/S are per-song session state, never written to the project.

## Compatibility and failure modes

- Phones and Box: no session change; the `voice-take.ts` change is additive.
  The conform DSP is portable C++ under `native/playback/` so a phone player can
  produce the same lane later; the mixer removal must keep phone and Box builds
  green.
- Conform fails or the raw WAV is missing: lane absent, clip shows the cause and
  Retry, song plays. Seam refused: existing rebuild fallback. Unknown sidecar
  version: not laned. Disk full: typed error, no partial file.

## Risks

1. Double time-pitch on stretched takes is audible on voice. Listening check at
   Tr 0.5/0.75/1.25 and Xr ±2/±5 before the listen path is deleted (WP5).
2. Anchors across a tempo seam are unproven: the history holds about 2.7 s and a
   seam may raise the discontinuity serial that stops a take today.
3. Whether a WAV lane streams, and the cost of a lane-set change where lanes are
   decoded (Linux), is not read yet (WP0).
4. A placed file is up to song length (about 29 MB per 5 min, PCM16 mono).
5. Old takes with mid-take changes can be off by tens of ms (no anchors).
6. Removing code from the shared `TrainingPcmMixer` touches phone training cues.

WP1 retains the first sample's input/output/graph latency basis for all anchor
queries, preserving existing placement math and the measured `startPositionSec`.
A tempo seam can change graph latency; changing the subtraction mid-take could
make the map regress. Hardware verification must record a tone take across a
tempo 1 → 0.5 seam and measure anchor error in milliseconds before, at and after
the seam. An error above 5 ms opens a follow-up on audible-history mapping.

**Seam acceptance gate (mac driver `tests/e2e/mac/voice-take-lane-e2e.cjs`).** A
generated take with anchors `[0, 4 s at 1x, 8 s at 0.5x]` and 20 ms 1 kHz bursts
at take 1, 3.9, 4.1 and 7 s is conformed and measured; the gate is the
energy-weighted centroid of each burst within 2 ms of its anchor-mapped position.
The 25%/70% threshold onset is printed but not gated: the time-stretch itself
smears it by about ±7.5 ms, which is inherent, not an alignment error. Anchors of
a real recorded take across a tempo change still need a microphone run.

## Work packages

Coordinator: Claude `opus` (specs, result review, commit gate, `code-reviewer`
on each staged diff). Risky Codex code is reviewed by Claude `sonnet`. Workers
share the feature tree with disjoint files and unique build directories.

**WP0. Inventory (read-only).** Research / Codex `gpt-6-luna` / medium; table
spot-checked by Claude `haiku`. No edits. With file:line: can a WAV lane stream;
cost and gap of a seam when one lane is added, replaced or removed (streamed and
decoded); does a tempo/transpose seam bump `discontinuitySerial` or stop a
running take; pause during recording; every caller of `playTake`/`stopTake`/
`listen` and its i18n keys; any existing offline Signalsmith render. Depends: none.

**WP1. Timeline anchors.** Risky (placement math) / Codex `gpt-6.1-sol` / high;
Sonnet review. Files: `src/main/voice-takes.ts`, `src/shared/voice-take.ts`,
`tests/unit/voice-takes.test.ts`. Evidence: a fake presentation with a tempo
change at a known project frame yields anchors within 1 ms; the test fails when
anchors are replaced by wall-clock `atSec` (negative control); old sidecars
load; mobile typecheck and jest. Depends: WP0.

**WP2. Offline conform.** Risky (time-pitch, file integrity) / Codex
`gpt-6.1-sol` / high; Sonnet review. Files: new `native/playback/take_conform.*`,
new `tests/native/take_conform_tests.cpp`, `CMakeLists.txt`,
`native/electron/capture_addon.cpp`, `src/main/capture.ts`,
`src/main/audio-process-rpc.ts`, new `src/main/voice-take-conform.ts` and its
unit test. Evidence: ctest under ASan/TSan; a click-train take with three tempo
segments lands every click within 1 ms of the project grid; a sine sung at
`Xr = +2` conforms within 5 cents of unshifted; the identity path is
sample-equal; trim never exceeds song duration; ignoring segment 2 fails
(negative control); cache-key and atomic-write tests. Depends: WP0; parallel
with WP1 (anchor shape pinned here).

**WP3. Take lane in the engine.** Risky (sync, seams, recording) / Codex
`gpt-6.1-sol` / high; Sonnet review, Opus reads the final diff. Files:
`src/renderer/src/audio/engine.ts`, `audio/desktop-native-playback.ts`,
`audio/voice-take.ts`, `src/main/voice-takes-ipc.ts`, `src/preload/index.ts`,
`tests/unit/desktop-native-playback.test.ts`, `tests/unit/voice-strip.test.ts`,
new `tests/e2e/mac/voice-take-lane-e2e.cjs`. Scope: decisions 1, 6-9 and the
M/S rules. Evidence: a unit test per rule; the driver records a loopback pulse
take and finds pulse-to-song alignment within 10 ms (VS-REC-004) at tempo
0.5/1/1.5 and transpose 0/+2, after a seek, inside an A-B loop and after a
count-in; a deliberate 30 ms offset fails it; a saved project contains no take.
Depends: WP1, WP2.

**WP4. Voice strip UI.** Routine / Codex `gpt-6.1-terra` / medium; Sonnet
review. Files: `components/VoiceStrip.tsx`, `voice-record-button.tsx`,
`VoiceTrackSettings.tsx`, `voice-format.ts`, `voice-strip.css`,
`src/shared/i18n/*/voice.ts`, component tests. Scope: remove both Listen
buttons; M/S with disabled reasons; preparing and error clip states; "voice
shifted" and "approximate" tags. Evidence: unit and a11y assertions, i18n rules
check, no orphan keys, screenshots on mac and windows-field. Depends: WP3.

**WP5. Remove the listen path.** Risky (shared real-time mixer) / Codex
`gpt-6.1-sol` / medium; Sonnet review. Files: `native/playback/training_pcm_mixer.*`,
`presentation_history.h`, `native/electron/training_audio_session.cpp`,
`tests/native/take_playback_tests.cpp` (deleted; each case mapped to its
replacement), `CMakeLists.txt`, `src/main/voice-takes.ts`, `voice-takes-ipc.ts`,
`capture.ts`, `audio-process-rpc.ts`, `src/shared/voice-take.ts`, bridge
manifest. Evidence: grep finds no `playTake`, `TakeStream`, `voice:play`;
training-cue ctest and `shared-training-audio-smoke.cjs` green; phone and Box
native builds compile. Depends: WP4 and the risk-1 listening check.

**WP6. Spec and docs.** Docs / Claude `sonnet` / low. Files:
`docs/specs/voice-strip/spec.md`, `manual-test.md`, `docs/adr/0014-voice-strip.md`
(pointers), `docs/NATIVE-PLAYBACK-BRIDGE.md`. Evidence: no "Listen",
`playing-take` or R3 text left; links resolve. Depends: WP5.

**WP7. Verification.** `e2e-verifier` on mac and windows-field together, after
WP3 and after WP5; hardware loopback numbers go to `singz-dev`.

## What this unblocks

M3 takes list (active take per lane) and "Add to song as track" (a copy of `C`);
take playback on phones and Box as a plain lane file; deleting the second voice
path and the song-settings hijack of "Listen with song"; comping and overdub
later without new real-time code.

## Open

- Owner: confirm decision 3 (voice follows the song key) against the alternative
  (voice always at sung pitch, out of key when the song is transposed).
- Per-lane native offset versus baked placement, decided by WP0/WP3 numbers.

## User decisions

- Take pitch: the voice follows the song key (shifted by current minus recorded transposition), as a VISIBLE adjustment, not a hidden one: the voice lane header and the Track settings popup show the applied shift (for example "Pitch follow +3 st") and a bypass switch; the clip tag keeps "voice shifted" beyond about 3 semitones. Decided by the user.
- The pitch adjustment is the first effect of a future FX chain on the voice track: model it now as a named, ordered effect slot ("pitch-follow") with its own parameters (enabled, amount derived from the song key, later manual offset, formant preservation when the shifter supports it), stored per take/lane, so adding more effects later (EQ, compressor, reverb, tuner) is additive. WP1 to WP3 must keep the conform step parameterised by an effect description, not hard-coded, and WP4 builds the visible control around that slot. The FX chain itself (UI, ordering, presets, live vs offline effects) is out of scope for this ADR and needs its own decision record.
- The take plays as a lane under the normal Play; the "Listen" and "Listen with song" buttons go away (WP5), after a listening check of stretched takes.
