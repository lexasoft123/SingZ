# Native playback faster than legacy: every player-session rule green

Branch `codex/dsp-graph-plan`, written 2026-09-04 at tip `7c10bbb`. Companion to
[DSP-GRAPH-PLAN.md](DSP-GRAPH-PLAN.md) (the architecture) and to the per-rule mechanism list
kept at `~/.claude/plans/native-all-rules-pass.md` on the dev Mac.

## Where it stands

The native graph backend must be no worse than the legacy path on every rule of
`mobile/tests/player-session.cjs` (58 rules on Android, 56 on iOS). Clean runs at `ff5be2e`
(2026-09-04 morning): Android 50/58, iOS 44/56. Since then:

- `64a3293` — Play after the end of the song no longer resolves Completed off a stale
  published frame (the core's `resume()` resolves PreRoll/Playing and leaves Completed to the
  callback); the iOS `end → Play again: null` should now read a number.
- `7c10bbb` — the telemetry poll reads a session-only bridge call (`session()`, same name and
  arity on both phones) instead of re-enumerating every audio device and marshalling the
  capability block every 400 ms.

Their effect on the CPU rules is **unmeasured**: the one after-run was polluted by host load
and a 45-minute load-gated retry per platform gave up (1-min load 7–10 from the user's own
apps). On this Mac the CPU columns are only honest on a quiet host; the POCO phone is the
instrument that sidesteps host load entirely.

Failing rules at `ff5be2e`, both platforms: the worst-of-4 seek, metronome touches (iOS),
training on, metronome save (iOS), pitch-change CPU, pause holds the position, seek
pull-back (Android), Play → position advancing (iOS), CPU idle / playing / backgrounded,
iOS RSS (+70..124 MB), end-of-song restart (iOS, fixed by `64a3293`).

## Why the legacy engine measures faster: an architecture comparison

The legacy engine on the phones is Web Audio implemented by react-native-audio-api (the
desktop's is Chromium's Web Audio); the native engine is the zcore/zdsp session. The DSP is
not the difference: simpleperf on the same 12 s window put `libsingzcore` at 326 samples
against the legacy engine's 822. Native loses on the **control plane**, through three
architectural choices, and one piece of its own design that was never built.

**1. A live, mutable graph versus a rebuilt generation.** Legacy mutates in place:
`setMasterGain` is `gain.setTargetAtTime` (`mobile/src/engine.ts:414`), pitch is
`stretchHost.setSemitones` on a patched native stretch node (`:421-426`), a metronome edit
changes a gain and re-arms JS-scheduled oscillator clicks (`:677-688`), training is gain
automation on a 50 ms timer (`:637`). Only a rate change or a seek recreates buffer
sources, which share the decoded buffers and cost milliseconds. Native treats cues,
training and pitch as prepare-time configuration, so every such edit is
`stop → unloadRetainingLanes → prepare → configureOutputSession → openOutput → start`
(pinned as exactly those six calls in `mobile/__tests__/native-playback-b2.test.ts:1976-1983`):
the simulator log shows four `preparing graph` generations for three metronome touches,
150–500 ms of silence each, a dead seek window (`capabilities.seek` false), and the CPU
spike the pitch-change phase measures. `DSP-GRAPH-PLAN.md:48` specified "an immutable
execution plan swapped atomically at block boundaries" and `:1830` "hot-swapped structural
rebuilds at the signed project frame"; the implementation realized "immutable" as "a whole
new generation" and the block-boundary swap was never built. Lane retention (`ca11bd4`)
patched the largest cost, the decode, and left the rest.

**2. A persistent stream versus a stream owned by the generation.** Legacy opens its
output once per context (Android `AudioPlayer::openAudioStream`, Exclusive + LowLatency +
128-frame quantum; iOS one shared `AVAudioEngine` with source nodes attached) and then only
suspends and resumes it; `play()` pays `ctx.resume()` only when suspended
(`engine.ts:942`). Native re-runs `configureOutputSession` (the audio session / audio
focus), `openOutput` (RemoteIO or Oboe open) and `start` for every generation, then
withholds the position until a ~180 ms latency-history warm-up declares the audible
projection current: first Play 373 ms on iOS against legacy's 223, and every rebuild pays
it again.

**3. An in-process clock versus polled, projected telemetry.** Legacy's position is a
pure computation on a synchronous JSI getter: `startOffset + (ctx.currentTime −
startedAt) · rate` (`engine.ts:473-489`, `BaseAudioContextHostObject::getCurrentTime`);
pause captures `startOffset = audioPosition` from the same clock (`:1067`), so drift and
pull-back cannot exist by construction, and it costs nothing per tick. Native has no
synchronous read on either bridge; the facade polls a ~75-field block 2.5×/s across an
async promise (JSON→WritableMap on Android, strict validation in Hermes), projects by
wall-clock between polls, adopts seek targets optimistically, and mixes two clocks (the
audible frame in telemetry, the rendered target on a seek). That is the pull-back, the
pause drift, the delayed "advancing", and the Hermes CPU the profile attributes to
allocation and scheduling. `7c10bbb` trimmed the payload; it did not change the model.

**Where native already wins**, because its architecture is right there: opens (3.9 s vs
7.6 s on Android), the second song, reopen after restart, the end-of-song restart, unload
on leaving, and the render itself. The plan therefore changes the three control-plane
choices and keeps the audio plane.

## Plan

Each step: change → mutation-checked tests → both suites on a quiet host or the phone.
Native code changes require rebuild + reinstall before any device run (verify with `nm` on
the simulator dylib and the APK md5 against the emulator's). Every commit goes through the
code-reviewer gate.

### Step 0 — trustworthy measurement (½ day)
- `mobile/tests/player-session.cjs` (+ `player-session/{ios,android}.cjs`): sample the 1-min
  load at start and before every CPU phase; refuse to start on a busy host unless
  `ALLOW_BUSY_HOST=1`; print the load beside every CPU row; add `--wait-quiet` (three
  consecutive quiet samples, bounded). Print the negotiated callback size for both backends.
- Then the missing after-measurement of `7c10bbb` on both platforms, and the POCO run
  (`--platform android`, `ANDROID_PKG=com.lexasoft.singz.debug`, built with
  `-PdebugAppIdSuffix=.debug`).

### Step 1 — an in-process clock for native (choice 3; ~2 days; JS + both bridges)
- One **blocking-synchronous** bridge method, same name and arity on both bridges —
  `positionNow()` → `{generation, transportState, renderedProjectFrame, continuousFrame,
  remainingPreRollFrames, seekCount, ageMs}` (as shipped: the audible frame is the caller's
  one subtraction from a latency it already polls, and the host time became an AGE on the
  steady clock so the two sides never compare clocks) — read from a second session-owned
  seqlock the callback publishes, never touching the mailbox. iOS `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD`, Android
  `@ReactMethod(isBlockingSynchronousMethod = true)`; the desktop addon already answers
  synchronously. React Native is 0.86 with the new architecture and Hermes; **spike the sync
  method first** (one call, both platforms, under bridgeless) — if the interop refuses, the
  fallback is a JSI host object installed the way react-native-audio-api installs its
  context.
- The facade's `position` becomes a computation on that read, exactly legacy's shape: the
  rendered position from the core's frame, `displayLatencySec` and the singer's trim applied
  in one place for both backends; a seek adopts the accepted target on the rendered clock; a
  pause captures the rendered frame at accept. The 400 ms poll shrinks to a slow
  state/terminal/route poll (1 s playing, 2 s paused or Android-backgrounded; iOS
  backgrounded keeps 1 s since it keeps playing).
- Flips: pause holds, no seek pull-back, Play → advancing (both), CPU idle and most of CPU
  playing; removes the projection-limit, echo-guard and pre-roll-poll machinery.
- Tests: b2 on the sync read (pause then advancing ticks → unchanged; seek → never below the
  target; a start before the audible projection is current → the position moves); the two
  packaging suites' method lists (iOS's is exact); `telemetry-poll-mirror.test.ts` for any
  new constant.

### Step 2 — the stream and session outlive the generation (choice 2; ~3–4 days; core + hosts + facade)
- The host output and the audio session are opened once per song and kept across
  generations: `openOutput`/`start` on a generation whose host stream is already running
  attach the new graph instead of reopening; pause suspends rather than stops; the Android
  background park suspends the stream (no silence rendering) and resumes on foreground —
  this replaces the earlier idea of stop-then-reopen-at-frame; iOS keeps rendering by
  decision.
- Core: the ownership coordinator learns "stream held across a generation handoff";
  `allCursorsAtStart()` (`native/playback/native_playback_session.cpp:3417`, gates at `:5509`,
  `:5678`, `:5685`) generalizes to the prepared entry frame so a re-prepare at the parked
  frame can attach without the start-from-zero rule. Native tests: park → suspend → resume
  from P without decode; generation handoff with the stream running; the cleanup proof still
  closes the stream on unload.
- Flips: Play → advancing on iOS (the 116→323 ms warm-up leaves Play's path), CPU
  backgrounded on Android, and halves every rebuild's silence.
- **Shipped (first slice):** the Android background park HOLDS the stream —
  `AudioHostBackend::suspend()/resume()` (AAudio pause on the open output stream, the
  timestamp sampler napping, every other host refusing = "keep rendering"), a `Suspended`
  host state, `suspendOutput/resumeOutput` on the session gated on both the requested and
  the RENDERED transport state, the facade holding after the park's rendered pause (and for
  a song already paused) and releasing on foreground or at Play. Phone: backgrounded CPU
  49.1% → 14.1% (legacy 11.2%), foreground Play → advancing 435 ms legacy vs 152 ms
  native. **Not done here, by decision:** the stream kept across a generation handoff and
  the generalized `allCursorsAtStart` — Step 3's swap never opens a second stream, so a
  swap makes both moot; "Play → advancing on iOS" already flipped with Step 1's clock.

### Step 3 — the block-boundary swap the design specified (choice 1; ~1 week; core + facade)
- Prepare the next generation **while the current one renders** (lanes adopted from the
  running one, not parked), then swap the whole prepared graph at a block boundary at the
  same signed project frame on the running stream — `DSP-GRAPH-PLAN.md:48` and `:1830`. A
  cue, training or pitch edit then costs one off-RT prepare (~50 ms on the simulator) and no
  audible gap; rate changes ride the anchor protocol's single pending reanchor.
- Facade: `rebuildHandleCues` becomes `swapGeneration`; `capabilities.seek` never drops;
  the unchanged-config dedupe stays. If measurement then shows the ~50 ms prepare itself on
  a rule, per-table swaps (cue plan, training schedule, pitch scalar) are the optimization
  on top — not needed for parity first.
- Flips: metronome touches, training on, the worst-of-4 seek, metronome save, pitch-change
  CPU. Tests: native swap-at-boundary continuity (no discontinuity beyond the one reanchor;
  the old graph freed only after the switch is published — mutation: free early); b2 three
  touches = zero silence windows.
- **Shipped (3a, core):** `NativePlaybackPrepareConfig::swapFromGeneration` — the
  candidate is prepared while the named generation renders (its decoded lanes adopted, so
  nothing is decoded twice), and the host's render context is now a session-level
  `NativePlaybackRenderRouter` in front of the per-generation callback states: the render
  thread lands the seam itself, between the outgoing graph's last frame and the incoming
  one's first, copying the callback-owned clock across (`adoptClock`) and clearing the
  request, so no zdsp change and no shared runner were needed — every graph stays
  self-contained and the outgoing one is freed by the first status() or command after the
  landing. The swap never opens or starts: same stream, same route, same format. Measured
  in the native suite sample-for-sample: every frame reaches the output exactly once across
  the seam (no repeat, no skip, no silence), the transport carries Playing or Paused across
  untouched, and a stop or unload during the armed window retires both graphs on one host
  stop. Six mutants killed (clock not carried, request left armed, old graph never freed,
  freed while rendering, landing never comes, not retired at quiescence). The candidate's
  cancellation is by name (`cancelledSwapCandidate`) so giving up on a replacement never
  cancels the song; a refused or failed candidate leaves the song controllable
  (`liveBehindLatest`) and is unloaded as a cancelled generation is.
- **Shipped (3b, core):** a candidate with a Stretch stage lands on the frame its anchor
  was filled for. `armSwap` predicts the outgoing clock three nominal buffers ahead of its
  last publication (nextSlice's own Q32 advance replayed off the render thread, cut at the
  loop end and the duration, wrapped by the INCOMING loop — sound only while the outgoing
  mailbox is drained), primes the candidate's anchor and initial state there and arms the
  landing on that stream frame; the render thread splits the block there, the handoff
  wraps the adopted clock by the incoming loop and compares to the prediction: exact →
  anchor armed (`timePitchAnchorOutcome` 40); not exact (a stalled control thread, or no
  sound prediction) → plan discarded, the stage's prepared state renders the seam, a
  counted miss on the stage and `swapLateLandings` when a frame had been asked for. Paused
  lands on the parked frame, which is the anchor's. Thirteen mutants killed; the late path is
  driven through the `SwapArming` lifecycle hook. **Owed by the phone run:** the landing
  budget (three nominal buffers, less what elapsed since the publication read and two Stretch
  primes under the mutex) is unmeasured on a device — read `swapLateLandings` against
  `swapLandings` at rest before believing the seam. **Not yet:** 3c (the bridges'
  `swapFromGeneration` key, the facade's `swapGeneration` replacing the six-call rebuild,
  `capabilities.seek` never dropping, the JS telemetry guard accepting the outgoing
  generation until the seam, the capability tag bump), then the phone measurement.

### Step 4 — CPU on the phone (~1–2 days)
Measure after steps 1–3 on the POCO; only then the stream-mode A/B
(`PerformanceMode::None` + 2–4 bursts vs `LowLatency` in
`zcore/platform/android/audio_host_android.cpp:386`; note legacy already runs 128-frame
LowLatency callbacks, so fewer callbacks is not why legacy is cheaper on the emulator) and,
if anything remains, the legacy Hermes profile with `jsprof-hermes-android.cjs`
(kept beside the project memory on the dev Mac).

### Step 5 — iOS memory (~1–2 days)
`vmmap --summary` at idle-in-player for both backends before any theory; the likely causes
are the decode pool's transient peak held by the allocator (decode into final-sized buffers,
`malloc_zone_pressure_relief` after prepare) or a JS-side decode surviving under native.
Guard with an open-close-memory-shaped legacy-vs-native check on the simulator.

### Step 6 — acceptance
Three consecutive green runs per platform on a quiet host (58/58, 56/56 — the
metronome-save rule flips on a heavy tail, so three greens, not one), the POCO run, an
iPhone `--platform ios-device` for timings, the e2e-verifier pass, project memory and
`DSP-GRAPH-PLAN.md` updated with the live command surface, then build 48 via the
ship-ios-ipa skill.

## Verification, and what is out of scope
- After every step: `cd mobile && npx tsc --noEmit -p tsconfig.json`, `cd mobile && npx
  jest`, the native ctest gate (`cmake --build build/phase4-tests …` then `ctest`) for core
  steps, then `node mobile/tests/player-session.cjs --platform android|ios` on a quiet host
  or the phone.
- Commit from the worktree's own cwd with the message in a file passed with `-F`; the
  review-gate hook refuses a `cd` in the commit command and a heredoc.
- Out of scope, said out loud: *Play → first audible* stays reported-only (the two backends
  measure different events); iOS backgrounded CPU stays uncompared by decision; the desktop
  facade is untouched except for exposing shared core commands under the same names.
- Related but separate: the TS↔C++ bridge contract document and its agreement tests (the
  boundary audit of 2026-09-04) — its own session and branch, `codex/native-bridge-contract`.
