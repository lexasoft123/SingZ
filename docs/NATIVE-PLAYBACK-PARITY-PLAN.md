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
  `swapLandings` at rest before believing the seam. A second late source the reviewer
  named: a command applied in the block being rendered passes the drained-mailbox check
  while the telemetry sample is one block stale — safe (unanchored, counted), and part of
  what that counter will include.
- **Shipped (3c, facade + bridges):** the swap is announced as a capability BIT
  (`playbackSwap`, additive, read leniently) rather than a tag bump, so an older binary and
  every existing fixture take the six-call path unchanged; both phone bridges admit the
  `swapFromGeneration` prepare key (one more positional JNI argument on Android, the schema
  allowlist on both) and project the four swap counters. `rebuildHandleCues` keeps its one
  entry point: on a started song whose session and stream are both running it tries
  `swapHandleGeneration` first — one prepare naming the outgoing generation, the poll left
  running, no stop/unload/open/start — and falls back to the rebuild only on the core's
  `invalid-state` refusal (a held stream, a route that changed under the song); any other
  failure throws with the song still playing under its old generation. The handle accepts
  the outgoing generation's number from the telemetry and the clock until the seam
  (`swappingFromGeneration`); a second change arriving inside that window waits, bounded by
  `SWAP_LANDING_DEADLINE_MS`, for the seam before it reads the transport (the first cut read
  the outgoing generation's telemetry and stopped the song — review), and a seam that never
  lands runs the wait out and takes the rebuild; the backend asks `swapsInPlace()` before
  taking the scrub rail away, so `capabilities.seek` never drops for a seam. Nine facade
  mutants killed; b2 pins the one-prepare seam, a paused song and its loop carried across,
  the refusal fallback, a failed candidate leaving the song playing, no seam on a held stream,
  a second change waiting for the first seam, and a seam that never lands.
- **First phone run (POCO, .debug build, `poco-run-3c-1.log`):** the seams work — six in one
  session, metronome touches 137 ms vs legacy 217 (was 297), training on 100 vs 99 (was
  511), resume 172 vs 303, lane ramps 34 vs 91, seek worst-of-4 184 vs 110 (was 352). Two
  fails with one cause: Android grants audio focus BY GENERATION at
  `configureOutputSession`, a swap opens nothing, so the replacement owned the stream and
  not the focus and the foreground release of the background hold was refused (`Android
  audio focus is not owned`) — the song stayed held for the rest of the session. Fixed: an
  accepted swap prepare inherits the outgoing generation's focus. And the two rate-change
  seams landed late (`late 1`, `late 2`): the three-buffer budget is 12 ms at 192 frames,
  priming the Stretch stage on the phone costs tens — fixed: the budget adds twice the prime
  cost the candidate's own prepare measured (`timePitchPrimeNs`; under 5 ms ignored).
  Metronome save (478 vs 185) is the one rebuild-family rule left; CPU playing 123 vs 110,
  idle 15.1 vs 14.5, backgrounded 13.6 vs 11.6 are Step 4's.
- **Second, third and fourth phone runs (`poco-run-3d/3e/3f-1.log`): 51, 49, 49 of 58 — and
  all three measured a MUTANT binary.** The focus fix held throughout (foreground → Play
  110 ms vs legacy 438, the end of song parks, Play again 286 vs 367), but every seam after
  the first arm "did not land", the seam counter climbed by hundreds a second and the
  outgoing generation's clock stayed frozen: the phone APK and the simulator app had been
  built while `mutate-swap-core.py` was rewriting the core sources, so they compiled
  whichever mutant was applied when the compiler read the file — the "swap request left
  armed after landing" one, exactly the behaviour observed. The host suite lands exactly
  once (`aSeamLandsExactlyOnceHoweverManyBlocksFollow` pins it against a hundred blocks).
  Rule: never build a phone or simulator binary while a mutation script runs; a device result
  that contradicts the host suite is a stale or mutant binary first. What those runs still
  taught: the `.debug` APK compiles the core unoptimized (CMake Debug), so a Stretch prime
  costs hundreds of milliseconds there and the CPU columns are pessimistic; the landing
  budget is therefore 1.5× the prime and capped at 0.75 s (`kSwapLandingBudgetCapSeconds`,
  below `SWAP_LANDING_DEADLINE_MS`) so a slow prime lands late and unanchored rather than
  past the facade's wait, and status carries `swapPrimeNs`/`swapLandingFrames`, printed on
  every seam's log line.
- **Fifth phone run, clean binary (`poco-run-3g-1.log`): 55/58 — every timing rule passes.**
  Six seams, all exact (`late 0`), the two rate-change ones included now that the budget
  pays for their 55 ms prime. Native vs legacy: seek worst-of-4 133 vs 142 ms, metronome
  touches 150 vs 228, metronome save 204 vs 174 (inside budget), training on 100 vs 100,
  pitch +2 122 vs 125, pause 113 vs 92, resume 140 vs 304, foreground → Play 148 vs 442, end
  of song → Play 265 vs 374, open 8.8 s vs 19.3 s. What remains is Step 4's: CPU playing
  122.3% vs 110.8%, pitch-change 223.4% vs 201.3%, backgrounded 13.6% vs 12.1% (idle equal at
  15.1%; PSS lower in every phase) — all from the unoptimized `.debug` core, so the first
  Step 4 act is a release-flavoured measurement.

### Step 4 — CPU on the phone (~1–2 days)
Measure after steps 1–3 on the POCO; only then the stream-mode A/B
(`PerformanceMode::None` + 2–4 bursts vs `LowLatency` in
`zcore/platform/android/audio_host_android.cpp:386`; note legacy already runs 128-frame
LowLatency callbacks, so fewer callbacks is not why legacy is cheaper on the emulator) and,
if anything remains, the legacy Hermes profile with `jsprof-hermes-android.cjs`
(kept beside the project memory on the dev Mac).

**Shipped (2026-09-05):**
- **The phone had been measuring a -O0 core.** AGP's Debug configuration hands clang `-g`
  and no `-O` flag at all (read off `compile_commands.json`, not assumed), and the `.debug`
  APK is the only build a driver can measure — so every CPU column and every Stretch
  prime cost in Steps 1–3 was the unoptimized engine against Hermes. The Debug variant
  now compiles the app's own native code with `-O2` (asserts stay in, no NDEBUG;
  `-PsingzNativeUnoptimized=1` is the opt-out; React Native's own `appmodules` is
  untouched), verified on the compile lines of the core, the callback, the JNI shim and
  the Android host. Two POCO runs on that build (`poco-run-4a-{1,2}.log`, host load 5–7):
  **CPU playing 88.7% / 99.6% native vs 108.8% / 107.4% legacy; pitch-change 184.4% /
  180.5% vs 199.8% / 198.5%** — the two rules Step 4 was written for pass on both runs,
  with no stream-mode change; the seams' prime cost fell from 55 ms to 3–4 ms
  (`prime 3 ms · armed in 157 ms`). The stream-mode A/B is therefore not taken: what it was
  meant to buy is already there. Also folded into the same commit, found while closing a
  reviewer risk: the Android bridge tracked ONE generation, set at the claim, so while a
  swap was armed a focus loss or route change cancelled the candidate — which the core,
  correctly, answers by keeping the song playing — and the song rendered on under lost
  focus; and a refused or abandoned candidate's unload released the focus it had inherited
  while the song played on untracked. `NativePlaybackGenerationLedger` (pure, JUnit-tested
  off the device, five mutants killed) is the one account of both generations and the
  focus; fail-closed retires both; the facade acknowledges every landed seam through the
  existing `unload` of the replaced generation (which the core already answers as an
  acknowledgement), and the core's own answer to an unload — the live state for a cancelled
  candidate, `unloaded` for a teardown — tells the ledger which case it was. Not yet
  measurable by any driver: a focus loss taken between the arm and the landing (owed a
  device driver).
- **What the two runs still fail, and why each is or is not a backend property:**
  `CPU (backgrounded)` 13.1% / 13.6% native vs 12.1% / 11.7% legacy — consistent, about
  three scheduler ticks over the two-second sample, with the stream held and the graph
  parked; the third run carries a per-thread sampler (`top -H`, once a second) to say
  which thread spends them. `CPU (idle-in-player)` 15.9% / 15.5% vs 15.0% / 15.0% — one to
  two ticks, inside the sample's own resolution. `app restart → app ready` flipped sides
  across the three optimized/unoptimized runs (legacy 6779 / 5443 / 5519, native 5572 /
  6803 / 6872 — bimodal at about 5.5 and 6.8 s on BOTH backends), because the timing is
  host-side and its attach polled Metro's target list once a second and the pid twice a
  second while the rule's tolerance is about half a second: the measurement could not
  resolve the difference it was asked to judge. The first fix — polling Metro's list and
  `typeof __test` over the inspector at 250 / 100 ms — was withdrawn after one run: the
  native pass's process died 4 s after launch in Fabric's first commit
  (`MountingCoordinator::pullTransaction`, program counter in the scudo heap, on
  `mqt_v_js`), with the harness's 100 ms `Runtime.evaluate` poll the only new thing on a
  booting JS thread; one sample, but the same class as the inspector-during-decode crash
  this file's Android section already forbids. The restart is now timed by an IN-APP mark:
  `CatalogScreen` writes `singz.boot` to the pref store on mount, and the Android driver
  polls it through `run-as` at 100 ms (`awaitBoot`) before attaching at the old cadence —
  no inspector traffic until the app is up; the iOS drivers keep the host-side timing and
  its quantum. From the fourth run on the Android rule can answer.
- **Fourth run (`poco-run-4a-4.log`, in-app restart mark, per-thread sampler): 57/58.**
  Restart native 3797 vs legacy 3958 ms — the rule was the harness's quantum. Idle
  17.5 vs 26.6 (legacy sampled at host load 9.7), playing 95.1 vs 122.6, pitch-change
  178.3 vs 213.7. The one miss, `CPU (backgrounded)` 13.1 vs 12.2, the sampler explains
  thread by thread: in legacy's held window the app is its main thread alone (10–14%,
  AudioTrack 0, JS 0); in native's it is the same main thread (10.5%) plus the bridge's
  control thread at 2.6% — the facade's idle-rate poll, answered on Android by parsing
  the core's ~150-field JSON with org.json and rebuilding it as a WritableMap, every two
  seconds, for a stream that delivers nothing. Two cuts, both pinned and mutation-checked:
  the Android `session()` resolves the core's JSON TEXT and Hermes parses it (iOS keeps
  its dictionary built from doubles — its text parser is not correctly rounded), and a
  held stream polls at `NATIVE_TELEMETRY_HELD_POLL_MS` (10 s) instead of the idle rate,
  because the release on foreground meets a focus loss or a route change anyway (and the
  tick that discovers the hold does not read — the park just published the transport).
- **Fifth run (`poco-run-4b-1.log`, both cuts in): 56/58**, restart 3804 vs 3805 ms,
  playing 95.4 vs 106.1, pitch-change 181.8 vs 199.4 — and `CPU (backgrounded)` STILL
  13.5 vs 11.2, idle 15.6 vs 15.0. The sampler then showed what the rule could not: over
  the hold, native is its main thread alone at 10.7–14.2% with the bridge thread at 0.0,
  and legacy is its main thread alone at 10.3–18.5% — the same steady state. The harness
  compared a two-second `utime+stime` window taken three seconds into a seven-second
  hold, i.e. two different seconds of it, quantized to ten-millisecond ticks, and that
  is a rule no number of runs can settle. The backgrounded phase is now sampled over
  five seconds from one second into the hold (`sample(phase, windowMs)`; the iOS
  devices keep their fixed window). What is left of the idle gap (0.5–0.9 points at the
  same resolution) has one plausible source, unmeasured: every poll writes
  `telemetryAtMs` into the view state and notifies the screen even when a paused
  transport has not moved, one React commit per idle poll — noted, not chased.
- **Sixth and seventh runs: the five-second window still read 13.0 vs 11.7 and 12.9 vs 11.3,
  and exact per-thread ticks (`/proc/<pid>/task/*/stat` deltas, not `top` snapshots)
  found what the snapshots missed.** Two threads carrying the bridge control thread's
  name — Linux names a thread after its creator — each at 1.2% for as long as their
  generation lived, hold or not: the Stretch stage's loop anchor worker
  (`anchorWorker`, `signalsmith_time_pitch.cpp`), one per live time-pitch stage,
  polling every 2 ms to replenish loop-bank slots that are only filled while a recurring
  loop is active — and this project's persisted graph puts a Stretch stage at unity in
  every generation, so every song paid it in every quiet phase (the legacy engine has no
  such thread; its hold is the main thread alone at 10–14%, native's the same main thread
  plus these two). Activation happens on the render thread, so the worker cannot be
  notified; it now polls at 100 ms while no loop is active and at 2 ms once one is, inside
  the design's own margin (two pre-primed entries, a replenishment period reserved per
  wrap in the minimum loop length). Pinned through a wake counter in the anchor status
  (idle ≤ 12 wakes in 300 ms, active ≥ 30), two mutants killed.
- **Eighth run (`poco-run-4c-1.log`, worker fix in): 57/58** — idle 15.5 vs 16.0 (native
  under legacy for the first time), playing 93.2 vs 104.6, pitch-change 166.7 vs 188.5,
  backgrounded 11.7 vs 11.1. The exact ticks over that hold: native is its main thread
  at 11.8% plus binder at 3.7% and nothing else (17.9% in all); legacy's hold is main at
  11–14.6%, binder 4.4%, a JNI destructor thread 2.7% (19–23%). Thread for thread native
  is at or under legacy, and the 0.6 the harness still reads is three ten-millisecond
  ticks over five seconds. The CPU rules therefore carry the sample's own quantum as
  their tolerance — two ticks over the window, 1.0 point at 2 s and 0.4 at 5 s on
  Android (`tickPct` from the sampler; the iOS samplers report none and keep zero) —
  because two utime+stime windows taken at different moments cannot resolve less than
  that, and a rule that asks them to is decided by which second it lands on. **Step 4's
  engine work is done**: playing and pitch-change pass by 10–20 points on every
  optimized-core run, idle is inside the quantum, and backgrounded's 0.6 is three ticks
  where the tolerance is two — one tick outside, deliberately not widened to cover it: if
  it is systematic, a longer window shrinks the tick and shows it; the exact ticks say it
  is the main thread and binder on both sides, so the next quiet-host run decides. Not chased: the
  React commit per idle poll (see above). Host load during runs 4–8 was 5–12, and 88
  during run 8 (Chrome and XProtect on the Mac, not this work); the phone's own
  `utime+stime` does not see the host, the timing rules may.

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
