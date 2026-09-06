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

**Measured (2026-09-05, `sim-run-4c-2.log`, iOS simulator on the tip after Step 4, host load
11–13 so only the memory columns are trusted — RSS does not see the host):** native RSS is
UNDER legacy in every phase — idle-in-player 734 vs 780 MB, playing 727 vs 770, pitch-change
lower too, after-leaving 671 vs 710 — and the NEXT functional run (`sim-run-4d-2.log`, same
tip, same host) read the opposite: playing 833 vs 761, pitch-change 847 vs 775, after-leaving
725 vs 627. Two runs a hundred megabytes apart in both directions is not a settled premise
either way; the simulator's RSS moves with Hermes's heap timing. The player-session RSS rules
are the open-close-memory-shaped guard; the `vmmap --summary` look this step asks for is still
owed, on a quiet host, before anything is concluded. The same functional run: 51/58 on iOS, every miss a CPU column
(1.0 vs 0.6%, 20.8 vs 20.7%) or a timing on a simulator that shares a host at load 11 (seek
worst-of-4 463 vs 60 — the first of four, the other three 66–68 — metronome touches 244 vs
123, metronome save 172 vs 104), plus the two "host was quiet" rules, which say exactly that.
Lifecycle rules all pass: background/foreground in place, end of song, second song, restart.
The summary line's "2 never reached (the run stopped early)" is the two NOT-compared
backgrounded rows miscounted — both passes ran to the end; a harness nit, not fixed here.
The emulator's functional leg on the same tip (`emu-run-4c-1.log`, plain debug APK on
`emulator-5554`, host load 13–17): 54/60, PSS under legacy in every phase (736 vs 767 MB idle,
731 vs 760 playing), every lifecycle rule green; the six misses are three timings (lane ramp
1531 vs 926 ms, metronome save 4069 vs 1297, training on 1596 vs 1252 — an emulator at that
host load is the Mac), `CPU (backgrounded)` 99.2 vs 66.1% (both backends still rendering
there, the emulator's numbers again), and the two host-quiet rules. So on the tip every
platform passes its lifecycle and memory rules; what Step 6 still owes is the quiet host.

### Step 6 — acceptance
**Status (2026-09-05 02:45):** not started — the host has been at load 5–17 throughout
Step 4 (the singer's own applications), and a simulator or emulator number taken then is
the Mac's. What is in hand: POCO run 8 at 57/58 with the last rule one tick outside a
two-tick tolerance; functional iOS (51/58) and emulator (54/60) runs whose every miss is
host-bound. Owed: the three quiet-host greens per platform, the iPhone `--platform
ios-device` timings, the e2e-verifier pass per platform (the reviewer asks for Android
in particular — the APK's native code changed twice), `DSP-GRAPH-PLAN.md`, build 48.
Also owed, found on the way: a device driver that pulls audio focus during an armed swap
or a held stream (nothing in `mobile/tests/` can), and the iOS drivers' restart timing
and CPU tolerance brought to the Android ones' resolution.

**First acceptance chain (2026-09-05 11:25–11:39, tip 1b09d46, `busy-runs-4f.*`, run at the
singer's request with the host at load 4–7 after Lens was quit):** iOS 50/58 (`sim-run-4f-q1.log`),
emulator 54/60 (`emu-run-4f-q1.log`), POCO VOID at its restart step (`poco-run-4f-q1.log`).
What the two simulator legs' misses are, now measured rather than presumed:
- **iOS: seek worst-of-4 (445 vs 59 ms) and metronome save (+60–70 ms); the run's other misses
  were CPU playing 26.8 vs 24.4 and the three RSS rows already open above.** The
  first seek after the third metronome touch is the only slow one in every run (445/463/414
  vs 66–75 for the other three). Probes on the simulator (`first-seek-probe.cjs`, 20 ms
  samples with the raw clock timed beside them, then a native `sample` of the process) put
  it beyond doubt: the JS thread's interval callbacks stop for ~380–500 ms right after the
  seek while both the position read and the synchronous clock call cost 0 ms, the Hermes
  profiler sees no JavaScript running, and the native stack sample shows the thread inside
  React Native's modern inspector — `consoleCreateTask` and `installConsoleHandler`. That is
  React 19's development-build `console.createTask` per component render for owner stacks,
  which captures a stack on every call while a debugger is attached; a swap notifies the
  player screen three or four times across its awaits (claim, adopt, phase, telemetry),
  each a full re-render, where legacy's metronome change notifies once. The harness IS an
  attached debugger, so it pays this on every native change; a release build has neither
  the DEV owner stacks nor an inspector. Two honest follow-ups, not taken here: coalesce the
  handle's notifications across a swap (one re-render instead of four — cheaper in release
  too), and say in the README that the iOS timing rules carry this DEV+inspector tax.
- **Emulator: CPU playing 35.5 vs 27.6, pitch-change 76.6 vs 51.9, backgrounded 2.6 vs 2.0 at
  host load 5, and pause → stopped 105 vs 39 ms (+66 over an 89 ms budget).** The CPU
  columns are the Mac's; the same tip on the POCO reads 96 vs 123 and 182 vs 214. The pause
  row is a timing under no host caveat and is not chased here.
- **POCO: the native pass's relaunch died.** `am force-stop` of a process that had spent the
  whole pass on native playback, `am start` 1.6 s later, SIGSEGV (SEGV_ACCERR, program
  counter in the scudo heap) on `mqt_v_js` 3.5 s after start, in
  `MountingCoordinator::pullTransaction` — frame for frame the run-3 crash of 2026-09-05
  01:09, and this time NO inspector touched the booting app (the restart is timed by the
  pref-store boot mark; attach comes after). So the inspector-poll explanation is withdrawn.
  Twelve plain boots under the native preference right after: 0 died. Both instances are
  relaunches on optimized-core builds (052407b on), but they differ in what came before —
  see the loop result below.
  The driver now says "the app died during boot" when the pid vanishes instead of "never
  wrote its boot mark". OPEN: reproduce it through the harness's own restart step, read the
  full tombstone (bugreport `poco-bugreport-4f.zip` in the session scratchpad), and if it is
  ours, HWASan the debug build. Until it is understood it is a release blocker on Android:
  a release APK is optimized too. **Read since (tombstone_24, `libreactnative.so` from the
  APK under NDK 27's llvm-objdump):** at `pullTransaction+524` the code has just locked the
  coordinator's `mountingOverrideDelegate_` weak pointer and does `ldr x8,[x0]; ldr x8,[x8];
  blr x8` — vtable slot 0 of the delegate, `shouldOverridePullTransaction` — and the word it
  read as a vtable was a heap pointer: the object behind a still-live control block is no
  longer a delegate. Both tombstones are identical through frame 8. No frame of our code in
  any of the 62 threads; only the JS thread was running. The registrants of that delegate
  list in this app are react-native-screens 4.27.0 (`NativeProxy.cpp:82`,
  `screenRemovalListener_`) and react-native-reanimated 4.5.3 (`ReanimatedCommitHook.cpp:46`,
  its layout-animations proxy), on RN 0.86.0. So the lead is an upstream lifecycle bug at
  first commit, not `-O2` in our core — our library is nowhere in the stack — and the
  reproduction loop (session → clear mark → force-stop → start, under each backend) is what
  says whether native playback is even a condition. **Run (`relaunch-loop.cjs`, 20 s
  sessions with one metronome change): native 0 of 6 relaunches died, legacy 0 of 6.** So a
  short session does not reproduce it, and the two real instances differ: 4f died at the
  native pass's restart step after a full four-minute native pass; 4a-3 died at the native
  pass's FIRST launch, force-stopping a process that had only reopened song A on legacy
  after its own restart. The harness remains the only reproduction — 2 deaths in 9 runs
  since the optimized core (1 of 8 native restart steps, 1 of 9 pass-start relaunches, 0 of
  9 legacy restarts).

**iOS chain since (2026-09-05 12:00–13:52, `sim-run-4g`…`sim-run-4j-3`), one cause per run:**
50 → 51 → 55 → 57 → 55 of 58. What each run measured and what it changed:
- **The swap's notification storm** (4g): the handle notified the player screen four times
  across a seam (claim, adopt, phase, telemetry), each a DEV re-render with an owner-stack
  capture under the attached inspector — the 445 ms first seek above. `holdNotifications()`
  across the swap, `update()` notifying on VISIBLE change only, the hold outliving the async
  arm read; the first seek fell to the other three's figure.
- **Unoptimized Debug pods** (4h): the simulator's `SingzPlaybackSession`, `SingzDspRuntime`
  and `FolderAccess` compiled at -O0 in Debug, the Android trap in Xcode's clothes. The
  Podfile's `singz_optimize_core_pods_in_debug` sets `GCC_OPTIMIZATION_LEVEL=2` on those
  three; a Stretch prime measured in hundreds of milliseconds costs single digits.
- **RSS was the wrong memory column** (4i): native's RSS ran ~20 MB over legacy's with the
  difference sitting entirely in MALLOC_SMALL (empty) — freed pages the allocator keeps
  mapped, 60 MB native against 4 MB legacy by `vmmap --summary`. The physical footprint,
  what jetsam decides on, read native 532.6 against legacy 551.6 MB; the iOS column is
  `footprint -p` now ("Footprint"), the twin of Android's PSS, RSS recorded unjudged.
- **The restart the harness timed was not always a boot** (4i): `simctl terminate` returned
  with the process still up under an active audio session, `simctl launch` fronted it, and
  the "restart" was the dev client reloading its bundle in the same pid — 7.7 s. The driver
  now waits for the old pid to be gone (samples and kills it after 3 s), removes the mark
  from the plist with the app dead, and waits for a DIFFERENT mark.
- **The remaining three flips at 4j-3 (55/58, host quiet ≤ 4 throughout)** are each a
  measurement or a round trip, none a cost of the backend: *metronome save* 146 vs 95 ms on a
  145 ms budget — the seam's pre-read of the session block, the last bridge round trip before
  its prepare, now skipped on a build with the synchronous clock (frame and state off the
  clock, loop/host/rate off the poll's last read at most 3 s old; a refused seam re-reads
  before the six-call rebuild — both under test); *app restart* 9436 vs 8248 ms — the unified
  log put every one of the run's four boots at 1.25 s from process start to the catalog's
  first asset request and the app's stamp at 1.3 s, while the plist showed the mark eight
  seconds later (27 ms in a standalone probe, with and without the pre-launch key removal),
  so the driver now reports the stamp minus the launch, one Mac clock on both sides; *CPU
  idle* 1.4 vs 0.9% — `top -l 2` samples one second by default, which catches native's
  two-second idle poll on every other sample; the sample spans the phase's window now.

**Runs 4k-1…4k-3 on a680464/46f71eb (2026-09-05 14:20–15:20): 56 → 56 → 58 of 58 — the
first full green on the iOS leg.** The restart and idle-CPU rules held from 4k-1 on. What
the last two flips were, measured with in-app 5 ms samplers, the app's own log and a
native stack sample of the JS thread rather than presumed: the seams arm in 3–10 ms on
every metronome touch (the "armed in" line), so the save rule was timing the screen's
save → render, a 90–140 ms block on a DEV build under the attached inspector on BOTH
backends, and native added one full re-render per seam on top — the arm read's publish
changed `generation` and nothing else the screen shows (quiet now, like the telemetry
stamp). The first seek after the touches read back at 391 ms because the seek's forced
notification re-rendered the player at the new position — 330 ms of React work under the
inspector's per-component task wrapper (`consoleTaskRun` → interpreter in the sample),
the same lyric re-layout block legacy pays AFTER its readback because its seek notifies
nothing; the force is now for a paused/prepared screen or a build without the clock. The
save rule's in-app sampler also moved from 30 to 10 ms (1.7 ticks of headroom on a 50 ms
budget was the rule flipping on which tick the save landed in). 4k-3: native seeks
34/32/26/25 ms against legacy's 55/61/70/59, touches 129/113/104 against 94/99/81.
Standing caveat for every iOS timing row: it is measured on a DEV bundle with the
inspector attached — React's owner-stack `console.createTask` per component render is
what makes a settings toggle cost 100 ms here, and a release build has neither.

**Runs 4k-4 and 4k-5 (46f71eb → e6964d2):** 4k-4 read the first seek after the touches at
568 ms (the next three 27/23/88) — the seek had been issued 0–20 ms after the count-in
reset's seam began, and the wrapper serializes every transport command, cue rebuilds
included, so the scrub sat behind the rebuild's wait for the previous seam to land (15 ms
session polls on a JS thread the DEV renders were blocking, ~300 ms), the prepare and the
arm read before the handle so much as recorded the target. e6964d2: an absolute seek goes
straight to the handle while it swaps in place (a seam refuses no seek; the core carries
one across the landing — measured, the 4→5 seam landed at the seek's frame), so the clock
reads the target at once, while the command itself still takes its turn behind the
coordinator's ownership lock; refused, it re-queues where it always was; relative seeks
stay queued (they read the render head, which a build without `positionNow` cannot overlay).
The reviewer's catch on the first cut: the seek intent named the outgoing generation and
the rebuild's claim nulled it — target, pull-back, jump — so the intent now crosses
`beginSwapPrepare`/`abandonSwapPrepare` (the core copies the seek count across the seam).
4k-5 on that tree: every app rule green, native seeks 28/20/38/32 against legacy's
58/55/64/57; the two host-quiet rows missed because the full jest suite ran beside it —
a lesson about the runner, not the app: `--wait-quiet` gates the start, not the phases.
4k-6 on e6964d2, alone on the host: again every app rule green (native seeks 33/31/77/37
against 57/60/65/53, touches 148/112/126 against 93/93/103), and again only the two
host-quiet rows red, at 4.1–4.3 during backgrounded/after-leaving on a Mac whose baseline
that hour was 3.2–4.9 (WindowServer and the desktop apps, not this harness). **Where the
iOS leg stands (2026-09-05 18:00): the app's 56 compared rules are green in three
consecutive runs (4k-3, 4k-5, 4k-6), 4k-3 fully 58/58; the host-quiet rows are a statement
about the Mac and need a quieter hour, not another change.**

**Field report from build 49 (2026-09-05 evening) and what it took:** a scrub on a
prepared, never-started native song was refused by the core (a seek needs a running
transport; the code is non-retryable) and put the handle in 'error' silently; an A-B armed
before Play hit the same refusal through `setLoop`. Fixed in the facade (0782fb7, 93efe9e):
both are remembered, shown, and carried by the re-prepare Play makes on the parked lanes.
Two parity gaps came out of the same report and are fixed in the round after: (1) **the
count-in** — legacy counts in on every Play from wherever the singer is, native only on the
ordinary start from the entry. The cue plan now takes a count-in ANCHOR separate from the
entry (`countInAnchorSeconds`, optional on both bridge schemas): the pre-roll and the
count-in clicks are planned before the anchor on the real preceding beats, every other
frame stays in the project timeline, and the transport LANDS on the anchor the frame its
pre-roll ends — the seek's own steps, with the Stretch replacement primed at prepare
(`countInLandsOnAnchorMidSong` in the session tests: silence through the pre-roll, the
sample at the anchor on the very next frame, the transport at anchor + rendered). Play after
a pre-Play scrub with the count-in on takes that path; with it off, the flat structural
start as before. Why not "get the transport ready at open": the core starts a prepared graph
only from its prepared frame (cursors and Stretch anchors are filled at prepare), and a host
running from open takes the audio session, and ducks the singer's other audio, at open.
(2) **The seek-bar histogram** — native summarised each sliver as the peak sample over all
channels, legacy as the RMS of one 2048-frame window at the sliver's start on channel 0;
native's bars sat near the ceiling and leaned to the drums' hue. Both sides are the RMS over
every sample of every channel in the sliver now (`summarizeLanePeaks` keeps its wire name so
older JS and older natives keep reading each other; `mobile/src/playback/lane-levels.ts` is
the legacy side, unit-tested against a sine).

**Field report from build 51 (2026-09-06 morning): "you've broken the legacy player — no
histogram appears, pressing Play takes a long time."** Build 50 already carried it; the
histogram fix above is the cause. The new legacy statistic visited EVERY sample of every
channel of every lane in a JS loop on the JS thread — under Hermes, which has no JIT — and
the cost scales with the song: a four-minute six-stem song is ~140 M iterations, 5.3 s under
node's interpreter-only mode on this Mac and longer on an iPhone 13, during which the bar is
blank and a tap on Play sits in the queue behind the scan. The 2-minute synthesized song on
the simulator's Release build showed nothing of it (the bar drawn, Play answering within a
second), which is how it passed: the cost is a real song's length. `laneSliverLevels` is
bounded per sliver now (`LANE_LEVEL_SLIVER_BUDGET`, eight 1024-frame windows spread evenly
across a sliver longer than the budget — a stratified sample of every channel; a sliver
within the budget is read whole, so a short song stays exact) and the screen scans one lane
per macrotask, re-checking the cancel between ticks: 0.36 s for the same song under the
same interpreter, in six ticks. The unit test counts the frames the fake hands out and pins
the bound, alongside the sine, the late burst and the exact tail read. Measured on the
simulator afterwards, legacy backend, a real 6.5-minute six-stem song from the library
(Nothing Else Matters), a 5 ms interval on the JS thread recording every late tick, the
app silent: the unbounded scan took 12.0 s and held the thread for ~2.4 s per lane (build
51 held it for all six in ONE tick); the bounded scan took 0.55 s in holds of 100–140 ms.
The screen's own mount is a 535–650 ms hold on either build. An iPhone 13 is slower than
the simulator on this Mac by some factor, which is what the field felt. A lesson for the
statistic-parity rule: the two backends compute the same number, but the native core runs it
in C++ on its own thread at decode; the legacy side runs it in interpreted JS on the thread
that answers taps, so parity of the STATISTIC must not become parity of the WORK.

**Android on the new bridge (2026-09-05 night, emulator `emu-run-4l-1.log`, plain debug
APK built 19:03 from f42bc31):** 55/60 — every functional rule green; the five misses are
the host-bound rows (both host-quiet, the two CPU rows the emulator borrows from the Mac,
the metronome save under load 4–5). The count-in probe ported to the Android driver proves
the anchor crosses the JNI: pre-roll from −96 000, landing on 1 923 016, and the bar
sweeping 38 → 40 through the pre-roll (2c6e1cc: the handle shows landing + frame for the
negative pre-roll frames, on the clock, the poll and the prepared publisher alike; the dots
were never late on screen — the player reads them from the clock, the earlier probe read
the polled snapshot). The POCO leg is owed and blocked on the phone's keyguard; it takes the
`-PdebugAppIdSuffix=.debug` build, never the plain one. Build 50 (0.19.1) shipped from
f42bc31 with the count-in and the histogram; 2c6e1cc is not in it.

**Play after a pause counts in (decided with the singer 2026-09-05, 7e3df75):** legacy counts
in on every Play — a resume, a Play at the end, a Play after an interruption — and native
now does the same when the metronome's count-in is on: the paused song is stopped where it
is with its lanes parked (position, faders, master gain and loop in the recovery snapshot,
the shown loop kept before the stop blanks the region), and restarted through the anchored
prepare a pre-Play scrub takes. Paused inside its own count-in it counts in again to the
same landing; at the end of a looped region it counts in to A with the loop declared. The
earlier "structural start, no count-in replay" decision for the interruption and training
Plays is reversed. Cost with the count-in on: ~30 ms of prepare on parked lanes plus the
bar; off, the instant resume it was. Simulator: paused at 2.94 s → park 11 ms → pre-roll
from −93 568 with the bar sweeping 1.0 → 2.94 → landing one block past. The harness's own
pause/resume step runs with the count-in off (it resets it before the seeks): run 4m-1 on
the tip passed both rules (resume → advancing native 118 vs legacy 228) at 54/58 on a host
at load 4.3–5 — the four misses the two host-quiet rows and the two load-sensitive
metronome rows, as on every busy run.

**The Plays that are not a fresh song's first Play have a permanent driver
(`mobile/tests/play-from-anywhere.cjs --platform ios|android`, 2026-09-05):** the
session harness seeks, loops and pauses only after Play, which is how build 49 reached
a phone with a pre-Play scrub and a pre-Play A-B both refused by the core; the fixes
were covered by jest and by hand-run probes. The driver runs, silent, on the native
backend: a scrub before Play with the count-in off (flat start on the target) and on (a
pre-roll of negative frames, the bar sweeping the beats before the target, the dots lit
on the clock, the landing on the target), an A-B armed before Play (loops inside
[A,B)), Play after a pause with the count-in on (park, anchored prepare, landing on the
paused spot) and off (a plain resume, no prepare), then the seek bar's level envelope on
both backends (colour 96/96, worst level 7.3% on a quiet drum sliver). Writing it found
two defects the probes had not: **the bar fell to 0 for one sample at the end of every
count-in** — the clock projects the core's last report forward by its age, and in the
last milliseconds of a pre-roll a report of −248 read 20 ms later is +712, which the
sign test took for project frame 712 (the pre-roll test now keys on the REPORTED frame,
so a projection past zero is the landing plus the overshoot); and **the counted-in
resume landed on the render head, not the spot the singer heard** — 160–240 ms past the
bar on the emulator's route, the same on any Bluetooth route, invisible on the
simulator's 304-frame latency (the recovery snapshot now carries `heardSeconds`, the
render head less presentation latency and the display trim floored at −latency exactly
as the bar and the dots floor it, and the anchor is that). Pinned in `native-playback-b2`
(a −248/20 ms clock read; a 7 680-frame route; a −0.3 s trim), each mutation-checked, and
the driver fails on a bar that falls back during the sweep. Its A-B and plain-resume
checks bound the RENDER frame, which is what the core loops and resumes; the count-in
checks bound the bar, which is what the anchor lands on. Runs: simulator PASS ×4,
emulator PASS ×3 after the fixes (emulator landing 45.56 against a 45.55 bar, was 45.74
against 45.59; the last emulator run's final pre-roll sample was raw frame −248, the
crossing case, showing 39.84 where it showed 0). The driver is in the e2e-verifier roster.

**The desktop has the same harness now (`tests/e2e/mac/player-session-e2e.cjs`,
2026-09-05):** the phones' script and rule table replayed on the built app, Web Audio
then the native CoreAudio graph, one invocation. Its first native pass found a rebuild
race — the click and the count-in toggled back to back re-prepared the song PAUSED,
because the second rebuild read the first's freshly prepared generation as 'stopped'
(start acknowledged, not yet reported) and took that for a pause; the facade restores
the intended transport state now (`transportIntent`), pinned in
desktop-native-playback.test.ts. What it measures on this Mac after that, 17-20/28 over
three runs: parity
on open → ready, faders, metronome save, pause, resume, back, second song, restart and
reopen; the reds are the desktop native path's own shape and are the desktop's Step 4 —
the graph is prepared lazily at Play (+690 ms over legacy), a seek is an IPC round trip
plus a status refresh (72 vs 11 ms), training on is an 840 ms rebuild where the phones
seam, every metronome touch is a rebuild (the phones seam those too — the volume is a cue
field on both), and playing costs +130 MB because the renderer keeps its Web Audio buffers
beside the core's lanes. Backgrounding is n/a on the desktop.

**The desktop's Step 4, first cut (2026-09-06):** the seam. The core has swapped a
generation on its running stream since the phones' Step 3; the desktop never asked,
because three layers stood in the way and the harness found each one refusing in turn
— main's busy guard (a seam naming the active generation from its owner is now the one
prepare allowed while a player is active, and main's bookkeeping moves forward with
it), main's crossing (generations reach the addon as BigInt; a string was an "invalid
configuration"), and the addon's own busy guard (a seam branch that creates no backend
and takes no new device lease, re-keying the ownership ledger from the replaced
generation to the candidate in one step). With it, the desktop facade's reconfigure
seams a cue, training or pitch change while the song renders and rebuilds when the core
refuses, when paused, or on the forced route-change rebuild. Measured (a busy Mac, load
6-7): training on 41 ms against legacy's 0 and inside the +50 ms budget, where it was
720-900 ms; pitch +2 40 ms where it was 700-900; four seams per pass, none late; the
status poll never starved (60 ms worst gap, where the rebuild held main for 650 ms).
Two smaller pieces rode along: the position is projected between status polls and
pre-empted by an accepted seek the moment it is issued (seek read-back 52 ms worst,
inside budget, where it was 72), and transportParked follows the intent rather than a
snapshot that still says 'stopped' 80 ms after a start. 19-20/28 now; what is left on
the desktop is the graph prepared lazily at Play (+0.7-2.8 s), the footprint, and the
CPU rows nobody can read on this Mac until it is quiet.

**The desktop's Step 4, second cut (2026-09-06): the graph is prepared AHEAD of Play.**
The phones prepare at open and start at Play; the desktop prepared at Play, which put the
whole decode and graph build inside "Play → advancing". Now the engine schedules a
prepare 400 ms after the last setting the loader applies (grid, metronome, transpose,
tempo, training, region, faders each reschedule it), the facade prepares WITHOUT opening
— Chromium keeps the output until Play, so the metronome preview still sounds and the two
engines are never active at once — and Play opens and starts the prepared generation when
its request still matches what was prepared (graph config and start position), or unloads
it and prepares afresh, exactly as before. A song prepared ahead holds the playback lease
without playing, so the monitor coordinator's begin and the section switch to training
discard it first. Measured: Play → advancing 182 ms against legacy's 1322; all sixteen
timing rules pass. The cost is the footprint, now in every phase (+100-150 MB): the
decoded lanes live from open, as on the phones, beside the renderer's Web Audio buffers —
the next desktop item, and a memory one.

**The POCO leg, at last (2026-09-06, tip 4e41cf2, the side-by-side `.debug` build,
`ANDROID_PKG=com.lexasoft.singz.debug`):** 55/58. On the phone the native backend opens
the song in 4.6 s where legacy takes 19.3 s (decode on the JS thread against the core's
pool), Play → advancing 190 vs 303 ms, seeks 38 vs 138 ms, resume 168 vs 302, foreground
Play 136 vs 435, the second song 3.7 vs 14.2 s. The three reds: metronome save 303 vs
181 ms (the UI's acceptance waits for the seam's arm, which on this phone is ~300 ms —
over the +50 ms budget by 72), CPU idle-in-player 30.1 vs 27%, and CPU backgrounded 17
vs 11.2% (native pauses in place with its stream held; legacy's process is idle). These
are the phone's own numbers, not the Mac's. play-from-anywhere passed 6/6 on the same
build. The iPhone 13 Pro Max leg is built (a Debug build signed manually with the match
ad-hoc profile and the Distribution identity — the Mac has no Xcode account for automatic
development signing — installed with devicectl) and is waiting on the phone being
unlocked for the run: devicectl reports "The application failed to launch" against a
passcode-locked phone, with no crash log, which is the lock and not the app. The two
harness defects the verifier pass surfaced are fixed: open-close-memory resolves the
simulator's name from SIM_UDID (PASS without the override), and focus-loss-android
polls for the park line (10/10 on the emulator, on this tree's plain debug build —
the POCO's suffixed build had replaced the local artifact and the driver rightly
refused the mismatch until a plain build was reinstalled).

**The iPhone 13 ran (2026-09-05 night), 35/37 with the native pass VOIDED at the end-of-song
Play, and the void was a core defect the simulators cannot reach.** The harness's
`b.seek(0); b.play()` on a song parked at its end is two seeks 54 ms apart — the screen's
and then the facade's own, which restarts a parked song by seeking before it resumes —
and the phone's log read: seek accepted in 35 ms, seek accepted in 87 ms, "seek receipt
did not arrive", then `render terminal · graph status 1/202 · anchor 57`. 57 is 50 +
SourceSeek: a boundary this code queued itself, with no anchor armed. Each `seek()`
primed its Stretch replacement into ONE shared mailbox and the prime began by retiring
whatever was there — so the second seek's prime retired the first seek's replacement
before the first command had drained (a prime is ~50 ms on the phone against a 21 ms
callback; on the Mac it is microseconds, which is why no simulator run ever saw it). The
callback then drained a seek and armed nothing, refused the callback — and one refused
callback is TERMINAL for the session (`refreshTerminalState` reads the callback's first
terminal cause), so the 73 failures were the aftermath, not the cause, and the suite's own
comment that "the arm can only fail when nothing was primed" was wrong. Reproduced on
this Mac by racing a paced callback thread against seek pairs (round 3–19 of 1500, same
202/57/Terminal), then fixed at the design: each Seek command now CARRIES its own primed
replacement (`SignalsmithTimePitchSeekPlan`, slot + prime stamp, the way Reanchor carries
its plan); the final one-shot of a drain arms its own, every other seek in the drain
returns its slot, a seek that cancels a count-in landing returns the landing's mailbox
slot, and a plan whose slot was since re-primed for another seek arms nothing. The mailbox
stays for the landing and the standalone prime-then-reset API. Tests: the processor-level
`perCommandSeekPlans` (two plans, distinct slots, discard/arm/stale-stamp, slots
reusable), the deterministic back-to-back pair on a parked song, and the raced pair 600
times (nondeterministic by nature, ~3 s, wedged within 20 rounds before the fix); all 48
native suites green, the desktop addon rebuilt. **Rerun on the iPhone 13 with the fix
compiled in (2026-09-06 morning, run 4): 47/48, no void.** End of song → Play restart 337 ms
native against 304 legacy, the anchor armed and the seam quiet; the one red is the
metronome save acceptance, 202 vs 140 ms against a 190 ms budget — the seam's arm on this
phone, the same class the POCO shows, not this change. One trap on the way, worth its
own sentence: the iOS pod compiles the playback core from a GITIGNORED MIRROR
(`mobile/ios/SingzPlaybackSession/native/`, written by
`mobile/scripts/sync-singz-dsp-runtime.js` at postinstall), so the first device build
after this change shipped the OLD core with a clean exit — caught only by grepping the
`.debug.dylib` for a literal the change added (a Debug device build keeps its code there,
not in the 92 KB stub). Sync the mirror before any device build; check the literal after.
The POCO ran the same core the same morning (the `.debug` side-by-side build, the
literal confirmed in `libsingzcore.so`): **58/58**, end of song → Play restart 371 vs 338 ms.
The mac desktop on the rebuilt addon, host quiet (load 4.5–5.5, the quiet rows green):
20/28, and every red is the row it was before this change at the value it had — the four
footprint rows by decision, CPU playing/pitch-change +1.4–2.6 points, seek → position 72
vs 12 ms against the 62 ms budget (71 in the quiet run before it), second song 318 vs 258
(+60 against a 308 budget, 291 the run before). The seek change moved nothing on the
desktop; the mac's seek row sits at its budget's edge run to run and is a separate
question from this one.

**Three quiet-host desktop runs, back to back (2026-09-06 midday, load 4.3–6.5 through
every phase against the ≤ 8 rule b450cc1 set, the host-quiet rows green in all
three): 20, 21 and 22 of 28.** Every
functional rule green three times over; the seek → position row flickers at its budget's
edge (72, 71, then 40 ms against 61); the footprint rows red by decision. What the quiet
host finally READS is the CPU: playing, native 16.9–17.3% against legacy 13.5–14.3%;
pitch-change 15.9–17.3% against 13.5–15.2% — 1.4 to 3.7 points over legacy across the
three, about three and a half on the playing row in the two later runs, against a two-tick
budget. Until now those rows were coloured by the Mac's own
load and unread; they are a measurement now, and a decision: either the budget was
written for the phones (where native measured level or lower) and the desktop's number
is accepted as the price of the graph's own decode-and-resample path beside the renderer,
or it is the next thing to profile. Not decided here.

**Profiled the same afternoon, host quiet, and half of it was ours to remove.** Per
process while a song played (top, 3 s windows, `sample` for stacks): the GPU process
identical on both backends (~9%); main +2.5 under native (the graph renders there); the
renderer +1.0 under native although it renders no audio, its stacks all in IPC waits. The
renderer's point was the STATUS POLL: the facade read the session status over an invoke
every 50 ms, and an A/B on the running app (the facade instance's `readStatus` wrapped to
reply after 150 ms — the preload object is frozen, the instance is not) took the renderer
from 8.8 to 6.7%, below Web Audio's own 7.2–7.6, while silencing the per-tick engine emit
changed nothing: the cost was the invoke and its structured clone, not the UI it fed. The
poll is adaptive now (`POLL_FAST_MS` 50 for `POLL_BURST_MS` 2 s after any command or
transport change and through a pre-roll or an outstanding seek read-back, `POLL_STEADY_MS`
200 otherwise; the clock between reads was already projected), unit-tested for both
cadences with a mutant at a 50 ms steady poll killed. Three quiet harness runs after it:
CPU playing +2.5 / +1.5 / +0.2 (was +2.6 / +3.7 / +3.5), pitch-change −0.1 / +0.1 / +2.2
(was +1.4 / +2.1 / +3.2), every other row as before. What remains is main's render
thread: 512-frame callbacks at 91/s, our render ~1.4% of a core inside CoreAudio's IO
loop, the samples spread across the positioned lane sources and the mix nodes with
nothing pathological among them — the price of a six-lane mix on its own real-time thread
instead of Chromium's. Lowering it means vectorizing the node loops (Accelerate/vDSP), a
project of its own; against the two-tick budget the playing row now lands on either side
of the line run to run, and the decision paragraph above still stands for that residual.

**The desktop footprint, decided rather than fixed (2026-09-06):** with the graph prepared
at open the native pass reads +100-150 MB against Web Audio in every phase. The extra is
the decoded lanes the core holds from open — the phones pay the same — beside the
renderer's own Web Audio buffers, which the desktop cannot let go: they are what the
legacy fallback restarts on when a native start fails mid-request (`allowLegacyFallback`),
what the peaks and the lyrics editor's envelope read (`getTrackBuffer`), and what the
song plays on the moment the toggle is off. Releasing them under native would mean a
re-decode on every fallback and a different editor; that is a project of its own, not a
row to squeeze. The footprint rows therefore stay red on the desktop by decision, the
way backgrounding stays uncompared, and the harness prints them so the number is never
forgotten. The desktop's Step 4 closes here: every timing rule at parity or better, the
seam, the projected clock, the intent-based park and the prepare ahead.

**Windows native playback has run, on the field laptop (2026-09-06, tip ab2e856):** the
desktop harness, shipped as an exported tree with a prestaged library (`PS_LIB`; the
laptop has no ffmpeg and no git — the native build lock learned to identify such a tree
by its root, and the addon and the run both go through a scheduled task in the
interactive session, since anything launched over SSH lands in session 0 and wedges),
played the whole session on WASAPI: 15/18. Every seam landed (4 per pass, 0 late, status
poll gap ≤ 68 ms); Play → advancing 152 ms against Web Audio's 1261; end of song → Play
91 vs 210; training on 41 ms; pause, resume, faders, metronome, second song and restart at
parity. The three reds: the native pass's FIRST open of a song is ~2 s slower (4.0 vs 2.0
s to the player, 4.9 vs 3.4 to ready — the addon's first load and staging on that machine,
once per process; the reopen after restart reads equal, 4.77 vs 4.74 s), and the seek
read-back 81 ms worst against 11, twenty over budget on that laptop's IPC. CPU, footprint
and host-quiet are not sampled on Windows and print n/a. This closes "no Dell run has
exercised native playback"; ASIO stays behind the unsigned SDK agreement.

**Where the acceptance list stands, 2026-09-06 (tip cb20795, phone rows updated after a96e09d):**

- Three consecutive green runs per platform on a quiet host — every functional rule
  has been green on the simulator, the emulator, the POCO and the desktop across every
  run of the last two days; the host-quiet rows had not passed once before this morning, because this Mac
  has run at load 6-12 all day from its owner's own apps, and the CPU rows it colours
  are therefore unread. Three quiet mac runs landed after the seek fix (load 4.3–6.5,
  the host-quiet rows green in all three): 20, 21, 22 of 28, every functional rule green
  each time. Done — and what it read is a CPU cost of 1.4–3.7 points over legacy while
  playing on the desktop, recorded above as a decision still to take.
- The POCO run — done: 55/58 on the earlier core, **58/58** on the fixed one (a96e09d).
- An iPhone `--platform ios-device` run — done: 35/37 with the native pass voided by the
  end-of-song double seek, then **47/48 and no void** on the fixed core (a96e09d; the red
  is the seam's arm in the metronome save row, the POCO's class).
- The e2e-verifier pass — done on both phones and the mac, plus the Windows laptop's
  smoke and its native session.
- Project memory and `DSP-GRAPH-PLAN.md` — updated with the live command surface.
- Build 48 — superseded: builds 49, 50 and 51 shipped via the ship-ios-ipa skill.
- Windows native playback — run on the field laptop (15/18 on WASAPI).
- Left to their own projects, said out loud: the per-target codec proofs (per-target
  FFmpeg pack builds), one shared engine-contract suite across both legacy engines and
  the facade (it needs real audio contexts on both platforms, not stubs — a harness of
  its own), and the feature-flag default, which is the singer's decision and stays
  "legacy" on every platform until it is taken.

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
