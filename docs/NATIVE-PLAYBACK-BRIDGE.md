# The native playback bridge contract

The C++ playback core (`native/playback/`) is driven by TypeScript across three
different bridges: the iOS React Native module, the Android one, and the
Electron addon on the desktop. They share a core and a great deal of intent,
and they are **not** the same interface. This file states what actually
crosses, in which direction, in what units, who is allowed to reject what, and
where the three disagree on purpose.

It is a description of the code as it stands, not a design proposal. Every
claim here is pinned by a test — the surfaces by
`tests/shared/native-playback-bridge-manifest.json`, the shared behaviours by
`tests/shared/native-playback-agreement-cases.json`. If this document and the
code ever disagree, one of those two files is wrong as well, and fixing it is
part of the change. See **Changing the contract** at the end.

Line numbers drift. Every reference names the identifier too, so it can be
re-found after it moves.

- The phone surface: `mobile/src/playback/native.ts` (parsers, wrapper,
  request builders) over `NativeAudioRuntime`.
- The iOS bridge: `mobile/ios/FolderAccess/NativeAudioRuntimeBridge.mm` →
  `NativePlaybackBridgeSupport.mm`, `NativePlaybackBridgeSchema.mm`,
  `NativePlaybackBridgeResult.mm`.
- The Android bridge:
  `mobile/android/app/src/main/java/com/singzplayer/NativeAudioRuntimeModule.kt`
  → `playback/NativePlaybackBridgeSchema.kt` → `split/SingzCore.kt` →
  `mobile/native/bindings/android/native_playback_jni.cpp`.
- The desktop: `native/electron/playback_addon_bridge.cpp` → `src/main/capture.ts`
  → IPC in `src/main/index.ts` → `src/preload/index.ts` →
  `src/renderer/src/audio/desktop-native-playback.ts`.
- The core: `native/playback/native_playback_session.h` / `.cpp`,
  `playback_cue_plan.{h,cpp}`, `native_playback_graph_document.{h,cpp}`.

## 1. How the two phones and the desktop differ, in one paragraph each

**iOS** boxes every number as an `NSNumber` and never as text. That is not
style: `NSJSONSerialization` is not correctly rounded, so a double that
crosses as a string is a different double on arrival — the `mlGridJson` bug
cost 49 of 2041 probabilities their last bit. The comment at
`NativePlaybackBridgeSupport.mm` (`SingzNativePlaybackLanePeaks`, ~:977) says
so at the one place it would be tempting. Consequence: `uint64` counters
degrade to doubles, and the schema's JS-safe-integer gate is what keeps that
honest.

**Android** builds one JSON line in C++ (`appendStatus`, `resultJson`,
`appendCleanup`, `unloadJson`, `capabilityJson` in `native_playback_jni.cpp`),
crosses it as a `String`, and parses it in Kotlin with `org.json`, where every
`Number` becomes `putDouble` (`NativeAudioRuntimeModule.kt`, `putJson`). Text
is safe here because Kotlin's parser *is* correctly rounded. Doubles are
written `%.17g` by `appendDouble` (~:141) with non-finite coerced to zero, and
strings are escaped to pure ASCII by `appendQuoted` (~:66) so `NewStringUTF`
can never be handed invalid UTF-8.

**The desktop** has no such loss: `setCounter` and `setSignedCounter`
(`playback_addon_bridge.cpp` ~:77, ~:82) render 64-bit integers as **decimal
strings**, which is why every 64-bit counter in `DesktopPlaybackStatus` is
typed `string` — the 32-bit ones stay `number` — and `generation` becomes a
`bigint` only inside
`src/main/capture.ts` (`parseGeneration`). Inbound, `exactU64` accepts a
`napi_bigint` or a number no larger than 2^53−1.

## 2. Gates

A bridge is usable only when every one of these matches. The phones check all
of them in `parseNativePlaybackCapability` (`mobile/src/playback/native.ts`);
the desktop replaces the whole set with one capability string.

| gate | value | phones | desktop |
|---|---|---|---|
| `interfaceVersion` | `3` | `NATIVE_PLAYBACK_INTERFACE_VERSION` | not used |
| `playbackContractVersion` | `2` | `NATIVE_PLAYBACK_CONTRACT_VERSION` | `DESKTOP_PLAYBACK_CONTRACT_VERSION` |
| `playbackBuild` | `singz.native.playback-session.anchored-preview.v4` | `NATIVE_PLAYBACK_SESSION_BUILD` | `DESKTOP_PLAYBACK_CAPABILITY` |
| `buildId` (iOS) | `singz.ios.zdsp_runtime.phase-ios-q32-time-pitch-v3` | `NATIVE_PLAYBACK_RUNTIME_BUILDS` | — |
| `buildId` (Android) | `singz.android.zdsp_runtime.phase-android-q32-time-pitch-v3` | same | — |
| eight capability booleans | all `true` | `graph`, `audioHostAdapter`, `playbackSession`, `playbackCleanupProof`, `playbackHandoffLease`, `playbackTransport`, `scheduledCues`, `timePitch` | — |

`playbackBuild` is the core's own `nativePlaybackSessionCapabilityTag()`
(`native_playback_session.cpp`), so all three bridges get it from one place.
All three bridges reject a `playback` block whose `version` is not `2`
(`parsePlayback` in `playback_addon_bridge.cpp`, and the two
`NativePlaybackBridgeSchema` files). The desktop goes further and **refuses a
prepare whose `capability` field does not equal its own build tag**
(`parseConfig` in `playback_addon_bridge.cpp`) — the only capability-tag
refusal anywhere.

`ownership: "coordinated"` and `activation: "experimental-4c"` are published
by both phone bridges and **read but never gated** by the parser
(`native.ts`, `parseNativePlaybackCapability`). They are labels. Treat them as
documentation that happens to travel on the wire.

### Codec gate

`mediaCodec` carries `{abiVersion, formatMask, dynamicallyLinkedFfmpeg,
runtimeVersion, capabilityTag}`. `abiVersion` must be `1`, and
`nativeMediaCodecIsValid` (`native.ts`) accepts exactly two shapes and nothing
between them:

| shape | mask | ffmpeg | tag | runtimeVersion |
|---|---|---|---|---|
| base | `0x003` | false | `singz-prepared-audio-fd-wav-flac-v1` | empty |
| full matrix | `0x1ff` | true | `singz-prepared-audio-fd-ffmpeg-full-matrix-v3` | non-empty |

A third tag exists in C++ and no TypeScript parser accepts it:
`singz-prepared-audio-fd-ffmpeg-partial-runtime-v2`
(`zcore/src/media/decoded_audio.cpp`). A partial-ffmpeg build therefore reads
as "no native playback" on both facades. That is deliberate; it is recorded
here so nobody re-derives it from a silent decline.

Per-extension bits (`codecSupportsExtension` in `native.ts`, against
`zcore/include/zcore/media/decoded_audio.h`): wav `0x001`, flac `0x002`, mp3
`0x004`, **m4a needs both** AAC `0x008` and ALAC `0x010`, aac `0x020`,
ogg/oga `0x0c0`, opus `0x080`, aif/aiff `0x100`.

## 3. Methods

### The phones: thirteen, same name, same arity

This is a rule, not an observation. **A native method whose arity disagrees
with JavaScript is never dispatched and never says so** — no work, no error,
no red box, just an app that looks healthy. `mlGrid` shipped that way on iOS
for ten minutes of confusion. Arity below counts what JavaScript passes; the
promise pair (iOS `resolver:`/`rejecter:` segments, Android's trailing
`promise: Promise`) is excluded on both sides.

| method | arity | argument |
|---|---|---|
| `status` | 0 | — |
| `session` | 0 | — |
| `prepare` | 2 | generation, request |
| `configureOutputSession` | 1 | generation |
| `openOutput` | 1 | generation |
| `start` | 1 | generation |
| `stop` | 1 | generation |
| `transport` | 2 | generation, command |
| `setControl` | 2 | generation, control |
| `previewClick` | 2 | generation, sound (`0` ordinary, `1` accent) |
| `lanePeaks` | 1 | generation |
| `unload` | 1 | generation |
| `unloadRetainingLanes` | 1 | generation |

iOS additionally exports `codecTargetProof` (arity 0) behind
`#if defined(SINGZ_CODEC_TARGET_PROOF)`; Android's equivalent lives on
`SingzCore`, not on this module, so it is outside the shared surface.

The TypeScript wrapper (`nativePlaybackBridge` in `native.ts`) requires ten of
the thirteen to exist and refuses the whole module otherwise. Three are
optional with defined fallbacks, because they were added after the first
shipping build: `session()` falls back to `status().session`, `lanePeaks()`
resolves `null`, and `unloadRetainingLanes()` falls back to `unload()` — which
means an old binary silently loses lane parking rather than breaking.

`session()` exists because the poll runs 2.5 times a second and `status()`
re-enumerates the output devices every time. Asking the phone only where it is,
rather than what it is, is the whole point of the method.

`nativePlaybackClaim` and `nativePlaybackRequestCancellation` have no
`@ReactMethod`: they are reached through `prepare` and cancellation, and appear
only in the JNI surface below.

### Android's JNI surface

Twenty-two of the 41 `external fun` declarations in `split/SingzCore.kt` are
the playback surface. The other 19 are the splitter, analysis and the
audio-host and capture inventory — served by `Java_`-prefixed symbols, all in
`singz_core_jni.cpp` bar `nativeCodecTargetProof`, which has its own
`codec_target_proof_jni.cpp`. One of them, `replaceAudioHostDevices`, is on
the playback path: `refreshHostInventory` calls it from both `status` and
`prepare`. The playback
twenty-two are registered
dynamically by `RegisterNatives` in `JNI_OnLoad`
(`native_playback_jni.cpp`) — for playback there are deliberately **no**
`Java_…`-prefixed symbols. Registration is atomic: any mismatch fails
`JNI_OnLoad` outright
rather than surfacing at the first call. The manifest pins both lists and that
they are equal, because a rename on one side alone is a crash at load, not a
compile error.

### The desktop: a different contract

Sixteen addon exports, fourteen with an IPC channel and a preload method, two
with neither.

| export | IPC channel | preload |
|---|---|---|
| `preparePlayback` | `audio-host:playback-prepare` | `prepareDesktopPlayback` |
| `openPlaybackOutput` | `audio-host:playback-open` | `openDesktopPlayback` |
| `startPlayback` | `audio-host:playback-start` | `startDesktopPlayback` |
| `pausePlayback` | `audio-host:playback-pause` | `pauseDesktopPlayback` |
| `resumePlayback` | `audio-host:playback-resume` | `resumeDesktopPlayback` |
| `stopPlayback` | `audio-host:playback-stop` | `stopDesktopPlayback` |
| `seekPlayback` | `audio-host:playback-seek` | `seekDesktopPlayback` |
| `setPlaybackLoop` | `audio-host:playback-loop-set` | `setDesktopPlaybackLoop` |
| `clearPlaybackLoop` | `audio-host:playback-loop-clear` | `clearDesktopPlaybackLoop` |
| `reanchorPlayback` | `audio-host:playback-reanchor` | `reanchorDesktopPlayback` |
| `setPlaybackLane` | `audio-host:playback-lane` | `setDesktopPlaybackLane` |
| `setPlaybackMasterGain` | `audio-host:playback-master` | `setDesktopPlaybackMasterGain` |
| `playbackStatus` | `audio-host:playback-status` | `desktopPlaybackStatus` |
| `unloadPlayback` | `audio-host:playback-unload` | `unloadDesktopPlayback` |
| `unloadPlaybackRetainingLanes` | **none** | **none** |
| `playbackLanePeaks` | **none** | **none** |

The last two are **dormant**: compiled, exported, reachable by nothing. For
lane parking the core says so itself — `NativePlaybackLaneRetention`,
`native_playback_session.h:133-137`, "LIVE ON THE PHONES, DORMANT ON THE
DESKTOP". Nothing vouches for `playbackLanePeaks` that way; it simply has no
caller. Naming both here is the point, since an export with no caller is
otherwise indistinguishable from one whose caller was deleted by accident.

Two further IPC channels have no *dedicated* addon export:
`audio-host:playback-providers` and `audio-host:playback-capability` are
served from main-process state, which `src/main/capture.ts` assembles by
calling `audioHostProviders` and `playbackStatus`.

Absent on the desktop entirely: `session`, `configureOutputSession`,
`previewClick`, and any training toggle. The desktop's transport is per-command
rather than one `transport(command)` call, and its `mediaCodec` block is
assembled in TypeScript (`capture.ts`) rather than read from the addon.

## 4. What goes down

### `prepare(generation, request)`

Fourteen fields, of which four are required — `lanes`, `outputDeviceUid`,
`outputChannels` and `sampleRate`. Units are stated because half of
them are frames and half are seconds, and the two are only interchangeable
once a sample rate is fixed.

| field | unit | bound | required |
|---|---|---|---|
| `lanes[]` | — | 1..16, each `{id, path, gain, muted, solo}` | yes |
| `lanes[].gain` | linear | 0..4 | no (defaults 1 on the phones) |
| `outputDeviceUid` | — | ≤1024 bytes (desktop) | yes |
| `outputChannels` | channel indices | 1..64 entries, each <64, no duplicates | yes |
| `sampleRate` | Hz | ≥1; the desktop additionally clamps to 8000..384000 | yes |
| `maximumFrames` | frames | 1..8192; default 4096 | phones no, desktop **yes** |
| `bufferFrames` | frames | `0` = let the host choose; 0..8192 (desktop) | phones no, desktop **yes** |
| `masterGain` | linear | 0..4 | phones no, desktop **yes** |
| `maximumRetainedBytes` | bytes | 1..2^53−1 | no |
| `handoffLease` | token | ≥1, JS-safe; omitted when zero | no |
| `playback` | — | `{version: 2, transport, cues}` | phones no, desktop **yes** |
| `training` | — | see below | no |
| `preparedStartProjectFrame` | project frames, signed | JS-safe | no |
| `initialTransport` | — | `{state: playing\|paused, loop?}` | no |
| `graphDocument` | — | `{format: 1, engine: "singz-dsp", nodes, connections}` | no |

`playback.transport` is `{entrySeconds, durationSeconds, playbackRate,
transposeSemitones}` — seconds, a ratio, and semitones. `entrySeconds` is
0..43200; `playbackRate` 0.25..4.0; `transposeSemitones` −24..24.
`durationSeconds` is schema-checked and then **discarded** by all three
bridges, which is worth knowing before trusting it.

`playback.cues` is `{click, countInBars, volume, accent, beatGrid?}`.
`countInBars` is 0..2, `volume` 0..1, and a `click` with no `beatGrid` is
refused by the builder in TypeScript before any bridge sees it
(`buildNativePlaybackPreparePlayback`).

`training` is either `{mode: 'period', periodFrames, laneIds, enabled}` or
`{mode: 'windows', windows, laneIds, enabled}`, never both. `laneIds` is 1..16
unique known ids; `windows` is 1..16384 entries, each with
`endProjectFrame > startProjectFrame`, and the set must not overlap. The
frames are project frames, computed in TypeScript as
`Math.round(seconds * sampleRate)`.

The desktop takes `lanes` as a **separate second argument**, not a request
field, and adds three fields the phones do not have: `capability`, `provider`
and `accessMode` (`asio` implies `exclusive`). It has no `handoffLease` because
it owns the lease internally.

### `transport(generation, command)`

Six kinds, exact keys, nothing else accepted:
`{kind: 'pause'}`, `{kind: 'resume'}`, `{kind: 'seek', projectFrame}`,
`{kind: 'set-loop', startProjectFrame, endProjectFrame}` with `end > start`,
`{kind: 'clear-loop'}`, `{kind: 'reanchor'}`.

Frames here are **non-negative** project frames, JS-safe, on both phones
(`parseJsSafeNonNegativeInt64` on iOS, `nonNegativeFrame` on Android): a
negative seek into pre-roll is refused at the bridge. So are the training
windows and `initialTransport.loop`. Inbound, `preparedStartProjectFrame` is
the only signed frame there is — the opposite of the session block, where six
are signed; see §5. The desktop spells each command as its own export, and
its `seekPlayback` takes a signed frame bounded by ±2^53−1.

### `setControl(generation, control)`

Exactly one of three shapes per call, enforced on both phones:
`{laneId, gain, muted, solo}` · `{masterGain}` · `{trainingEnabled}`. The
desktop has the first two as separate exports and no third.

### `configureOutputSession(generation)` and `openOutput(generation)`

Phones only. `configureOutputSession` is the AVAudioSession/AudioFocus
activation, kept as its own serialized command between legacy suspension and
the output open. Its iOS result carries **its own error table** —
`configuration-failed` and `verification-failed` are not
`NativePlaybackError` values (`NativePlaybackAudioSessionPolicy.mm`).

## 5. The session block

77 keys on both phones plus three Android-only ones, polled every 400 ms
(`NATIVE_TELEMETRY_POLL_MS`; 200 ms during pre-roll, where count-in dots
sample the poll grid and cannot be projected). `parseNativePlaybackSession`
returns `null` if any of the **69 strictly parsed** keys is missing or out of
type. The other eight are the six read leniently and the two nothing reads at
all, both noted below.

A `null` does not always cost just one tick. The wrapper substitutes an empty
session, and what happens next depends on the path. On iOS the generation gate
drops it, so the poll really is discarded. On **Android** the empty session
reads as `state: 'unloaded'`, the owner-retired branch fires first, and
playback stops with the wrong reason attached ("Android changed audio focus or
the output route"). Through `status()` on an older binary with no `session`
method, the same `null` makes the whole capability absent and native playback
disappears. The trigger for all three is native/JS drift, which is what this
document exists to prevent — so treat this list as load-bearing rather than
advisory.

Reader column: **poll** = read every tick by the transport projection or the
UI; **proof** = read to decide whether an operation succeeded; **log** = for
the log dialog and diagnosis only.

### Identity and state

| key | type / unit | reader |
|---|---|---|
| `generation` | uint, JS-safe | poll — stale generations are dropped |
| `state` | enum `NativePlaybackState` | poll |
| `hostState` | enum `AudioHostState` | poll |
| `terminalReason` | enum `AudioHostTerminalReason` | proof |
| `terminalOrdinal` | uint | proof — distinguishes two terminals of one kind |
| `message` | string | log (desktop calls it `error`) |

### Host format

`sampleRate` (Hz, float), `maximumFrames`, `nominalBufferFrames`,
`outputChannels`. All poll. The desktop nests these four under `format` and
adds `inputChannels`.

### Transport and projection

| key | type / unit | reader |
|---|---|---|
| `transportGeneration` | uint | poll |
| `transportState` | enum, 5 values | poll |
| `transportTelemetryQuality` | enum, 4 values | poll — gates whether position is trusted |
| `lastTransportBoundary` | enum, 11 values | poll — the discontinuity reason |
| `renderedProjectFrame` | **signed** project frames | poll |
| `audibleProjectFrame` | **signed** project frames | poll — what the singer hears |
| `audibleProjectionQuality` | `current` \| `unavailable` | poll |
| `continuousFrame` | uint frames | poll |
| `durationFrames` | uint frames | poll |
| `remainingPreRollFrames` | uint frames | poll |
| `renderedFrames`, `audibleFrames` | uint frames | log |
| `transportDiscontinuities`, `seekCount` | uint counters | log |
| `cueEventsCompleted`, `nextCueEventIndex` | uint | log — parsed strictly, read by nothing |
| `preparedStartProjectFrame` | **signed** project frames | proof — where this generation was prepared to start |

Outbound project frames are signed because pre-roll is negative:
`renderedProjectFrame`, `audibleProjectFrame`, `preparedStartProjectFrame`,
`preRollFrames`, `loopStartFrame` and `loopEndFrame`. That is the single most
common misreading of this block — and it does **not** carry back inbound,
where `transport` takes non-negative frames only.

### Loop

`loopEnabled` (bool), `loopStartFrame`, `loopEndFrame` (signed project
frames), `loopCount` (uint). All poll — see §9 for the one place TypeScript
and the core disagree about the loop end.

### Latency

`presentationLatencyFrames`, `graphLatencyFrames`,
`devicePresentationLatencyFrames`, `totalPresentationLatencyFrames`, and the
nested `latency` object `{outputDeviceFrames, bufferFrames,
externalRouteFrames, presentationFrames}`. All uint frames, all poll.

Two identities are enforced by the parser and reject the entire session if
violated:

```
latency.presentationFrames === presentationLatencyFrames
presentationLatencyFrames === totalPresentationLatencyFrames
                          === graphLatencyFrames + devicePresentationLatencyFrames
```

The desktop's `latency` has `inputDeviceFrames` and **no**
`presentationFrames`; the phones' has `presentationFrames` and no input.

### Time-pitch

`playbackRate` (ratio, >0), `transposeSemitones` (−24..24),
`timePitchAnchorsPrepared`, `timePitchAnchorsPublished`,
`timePitchAnchorMisses` (uint counters), `timePitchReplacementReady`,
`timePitchLoopPriming` (bool), and `timePitchAnchorOutcome` (uint code,
documented value-by-value at `native_playback_session.h`, ~:523-582). Poll for
the two scalars and the outcome; log for the rest.

### Memory and retention

`retainedBytes`, `graphArenaBytes` (bytes) and `laneDecodeFallback` (string,
empty when the parallel decode pool got what it asked for).

`parkedLaneBytes` and `parkedLaneCount` are emitted here by all three bridges
and **read by nobody**: `parseNativePlaybackSession` parses neither, and the
park proof in §8 reads them off the *cleanup receipt* instead. On this path
they are diagnostics, not state.

### Mix, training, cues, graph, health

`masterGain`, `referenceGain` (linear); `trainingEnabled` (bool),
`trainingLanes` (≤16 unique non-empty strings); `preRollFrames` (**signed**
frames), `cueEventCount`, `countInEventCount`, `countInBeatsPerBar`,
`previewClicksEnqueued`, `previewClicksStarted`, `previewClicksCompleted`,
`previewClicksPending`; `graphNodeCount`,
`graphConnectionCount`, `latencyCompensatedEdgeCount`, `topology` (string).

Health counters: `xruns`, `deadlineMisses`, `discontinuities`, `renderFailures`,
`adapterRenderFailures`, `terminalRenderFailures`, `parameterOverflows`,
`nonFiniteSamples`, `rejectedBlocks`, `graphStatusCode`, `graphStatusDetail`.

`lanes[]` carries `{id, cursorFrames, totalFrames, gain, muted, solo}` and
deliberately **no** peak envelope: it never changes for a generation and this
runs several times a second. `lanePeaks` publishes it once instead.

### Six keys read leniently

`countInEventCount`, `countInBeatsPerBar`, `laneDecodeFallback`,
`graphStatusCode`, `graphStatusDetail` and `timePitchAnchorOutcome` default
(to `0` or `''`) rather than rejecting the session. They are the compatibility
seam for a JS bundle newer than the native binary under it — which on the
phones is the normal state of affairs, since Metro serves JS live.

### Android's three extra keys

`sampleFormat` (always `"float32"`), `routeGeneration`, `streamGeneration`.
The desktop publishes the latter two as well; iOS publishes neither.

### The desktop's four extra keys

`callbacks`, `invalidCallbacks`, `graphSnapshot` (a whole structured graph, no
phone equivalent, gated by `validGraphSnapshot` which returns `null` on any
inconsistency), and `capability`.

## 6. Results, receipts, peaks and outputs

### Result

Phones: `{ok, error, generation, state, sampleRate, maximumFrames,
nominalBufferFrames, outputChannels, message}` — where `error` is the **enum
name** and `message` is free text. Android adds `sampleFormat`.

Desktop: `{ok, errorCode, error, generation, state, format, latency}`. Note
the swap, which is the single easiest thing to get wrong when reading across:

| meaning | phones | desktop |
|---|---|---|
| the `NativePlaybackError` name | `error` | `errorCode` |
| the free-text explanation | `message` | `error` |

The desktop also emits `ownershipRetained` on prepare, and adds exactly three
error codes to the core's fourteen: `native-audio-busy` and
`platform-not-ready`, raised by the addon and by main alike, and
`unauthorized-path`, raised by main only. The full
union is `DesktopPlaybackErrorCode` in `src/shared/types.ts`. Everything else
it returns, `invalid-generation` included, is a core name.

### Unload receipt and the cleanup proof

Phones: the result object with a nested `cleanup` of **eighteen** keys —
`safety`, `error`, `generation`, `state`, `retainedBytes`, `parkedLaneBytes`,
`physicalOwnershipRetained`, `processQuarantineRetainedBytes`,
`processQuarantineReserved`, `processQuarantinePoisoned`, `terminalReason`,
`coordinatorState`, `coordinatorEpoch`, `coordinatorOwnerSession`,
`coordinatorOwnerGeneration`, `handoffLease`, `globallyComplete`,
`fallbackSafe`.

Desktop: the result object with **four flattened** keys and no nesting —
`cleanupComplete` (the rename of `globallyComplete`), `retainedBytes`,
`parkedLaneBytes`, `physicalOwnershipRetained`. Everything else is dropped.
The renderer is required to read `cleanupComplete` and forbidden to infer
safety from `ownershipRetained` (`src/shared/types.ts`, `DesktopPlaybackResult`).

### `lanePeaks`

`{ok, error, generation, bucketCount, lanes[{id, peaksValid, peaks}],
message}` on all three, with `error` meaning the enum name **even on the
desktop** — the one place the desktop follows the phones' convention. The core
pins `bucketCount` at 96 (`kNativePlaybackLaneSummaryBuckets`); TypeScript
accepts up to 4096 as a defensive stack bound and requires
`peaks.length === bucketCount` exactly.

### Outputs

`{uid, label, default, channels, sampleRate}` on both phones, plus
`channelLabels` on iOS and `sampleFormat` on Android. The desktop has no
`outputs` in its status at all; device inventory is a separate export.

One subtlety worth keeping: iOS reads `default` from `device.defaultOutput`,
Android computes it as `device.uid == inventory.defaultOutputUid`. Android
also passes its inventory through `inventorySampleRate`, because the raw
`nominalSampleRate` can be zero — a listing that showed JS a usable 48 kHz
while the route check saw the zero is how every Android handoff came to be
refused.

## 7. Enum tables

Every wire string below is byte-identical across the bridges that publish it.
What differs is the **fallthrough**, and it differs on purpose in one case and
by accident in another. Both are pinned.

| enum | count | strings |
|---|---|---|
| `NativePlaybackState` | 8 | `unloaded`, `preparing`, `prepared`, `output-open`, `running`, `stopped`, `terminal`, `quarantined` |
| `AudioHostState` | 7 | `closed`, `open`, `running`, `stopped`, `device-lost`, `error`, `unsupported` |
| `AudioHostTerminalReason` | 7 | `none`, `route-changed`, `interrupted`, `media-services-lost`, `media-services-reset`, `device-lost`, `provider-failure` |
| `NativePlaybackTransportState` | 5 | `stopped`, `pre-roll`, `playing`, `paused`, `completed` |
| `NativePlaybackTransportTelemetryQuality` | 4 | `unavailable`, `initial`, `current`, `lastGood` |
| `NativePlaybackTransportBoundaryReason` | 11 | `none`, `stream-generation-changed`, `sequence-gap`, `sample-rate-changed`, `route-generation-changed`, `timestamp-quality-changed`, `clock-reanchored`, `source-seek`, `source-loop`, `device-lost`, `source-frame-overflow` |
| `NativePlaybackAudibleProjectionQuality` | 2 | `unavailable`, `current` |
| `NativePlaybackCleanupSafety` | 3 | `not-owned`, `complete`, `uncertain` (phones only) |
| `NativePlaybackCoordinatorState` | 4 | `available`, `native-owned`, `fallback-leased`, `poisoned` (phones only) |
| `NativePlaybackError` | 14 | `none`, `invalid-generation`, `invalid-state`, `invalid-configuration`, `cancelled`, `decode-failure`, `limit-exceeded`, `resource-exhausted`, `graph-failure`, `host-failure`, `provider-failure`, `queue-full`, `teardown-uncertain`, `unsupported-playback-rate` |
| `NativePlaybackGraphNodeRole` | 3 | `input`, `processor`, `output` (desktop only) |
| `NativePlaybackGraphNodeKind` | 15 | `unknown` … `unavailable-silence` (desktop only) |

`lastGood` is the one camelCase value on the wire. It is not a typo and
changing it breaks the parser's `oneOf` on both phones.

**Fallthroughs.** `NativePlaybackState` falls through to `terminal` on both
phones and to **`quarantined`** on the desktop. `NativePlaybackError` falls
through to `host-failure` in the core (`nativePlaybackErrorName`) and to
`provider-failure` in both the iOS hand-rolled copy and the TypeScript
`nativeErrorCode`. The graph-name tables return `nullptr` — they have no
string fallback at all.

Android and the desktop take error names from the core function. **iOS keeps a
hand-rolled copy** in `NativePlaybackBridgeResult.mm`. It calls the core
function twice — once for the `lanePeaks` wire field, once inside a
teardown-uncertain rejection message — and for every other wire field uses the
copy. That is a divergence register
entry, not a design.

## 8. Lifetime

```
claimGeneration ─▶ prepare ─▶ configureOutputSession ─▶ openOutput ─▶ start
                                                                       │
                       transport / setControl / previewClick ◀─────────┘
                                                                       │
                                        unload ── or ── unloadRetainingLanes
```

**Generations** are minted in TypeScript (`claimGeneration` in `native.ts`),
monotonic, never reused, never reset. Anything the core answers for a
generation other than the current one is dropped.

**The handoff lease** is a bearer token and the sharpest edge in this file. A
clean release mints one in the cleanup receipt; TypeScript stores it
process-globally and must carry it into the **next** prepare, after legacy
output is fully suspended. Discarding it wedges native playback for the rest
of the process — this song and every song after it. `prepareHandle` clears the
stored lease *before* invoking the bridge, because once the bridge is entered
the token may have been consumed even if JavaScript observes a rejection.
Zero means "claim fresh from Available"
(`NativePlaybackPrepareConfig::handoffLease`).

**Delivery tokens** are minted only by `openOutput` and `start` and are never
exposed to TypeScript at all — they live inside the bridges
(`acknowledgeDelivery`, `abortDelivery`, `abortPrepareDelivery`) and exist so
that a React Native promise rejection cannot leave the core believing an
output was delivered.

**Cancellation** has two layers. TypeScript holds a start-operation epoch and
re-checks it at every await boundary in the start sequence. On the core side
`requestCancellation` is the admission call a stop or unload dispatcher makes;
it takes no callback and simply advances the cancelled-through mark that the
decode pool polls. The callback with the sharp contract is the
`DecodeCancellation` argument to `prepare`
(`native_playback_session.h:777-784`): it may run on up to
`kNativePlaybackMaximumConcurrentLaneDecodes` decode threads *plus* the
calling thread, so it must be thread-safe, must not block, and must issue no
session commands.

**Park versus release.** `unloadRetainingLanes` keeps the decoded lanes so the
next prepare can adopt them; adoption matches on the whole lane set, same
order, exact source keys. The two outcomes have **two different proofs**, and
the park proof is not the release proof with a term removed:

```
graphSurrendered  = cleanup.generation === generation
                 && !physicalOwnershipRetained
                 && processQuarantineRetainedBytes === 0
                 && !processQuarantineReserved && !processQuarantinePoisoned

release  = graphSurrendered && globallyComplete && fallbackSafe
        && handoffLease > 0 && retainedBytes === 0

park     = graphSurrendered && receipt.ok
        && retainedBytes === parkedLaneBytes
        && globallyComplete === false && handoffLease === 0
```

A healthy park reports `safety: 'uncertain'` and `error:
'teardown-uncertain'`, so `receipt.ok` is the only thing left that
distinguishes it from journal exhaustion. On a park TypeScript deliberately
publishes no lease and does not release legacy output: the coordinator stays
`NativeOwned` across it, and the adopting prepare passes lease `0`.

A retry of a failed unload must use **the same retention**. Retrying a park as
a plain release silently drops the lanes the rebuild is about to adopt.

**None of this crosses into TypeScript on the desktop**, but the addon keeps
all three internally. It holds the handoff lease in its own owner struct and
replays it into the next `claimGeneration`; `openPlaybackOutput` and
`startPlayback` each mint a delivery token and turn a refused acknowledgement
into `TeardownUncertain`; and `unloadPlaybackRetainingLanes` really does pass
`NativePlaybackLaneRetention::Park` — it simply has no caller. What the
renderer sees of all of it is one optional boolean, `cleanupComplete`.

## 9. Validation: who rejects what

The core is authoritative. A bridge schema may reject earlier — that is a
better error message and a smaller blast radius — but no bridge is entitled to
*accept* something the core would refuse, and nothing downstream may assume a
check happened because one bridge does it.

| rule | core | iOS schema | Android schema | desktop |
|---|---|---|---|---|
| lanes 1..16 | yes | yes | yes | yes |
| **duplicate lane id** | **yes** | no | yes | yes |
| training ids unique | yes | yes | yes | yes |
| **training ids name a prepared lane** | **yes** | no | no | no |
| training windows disjoint, `end > start` | **yes** | yes | yes | yes |
| **duplicate graph node id** | **yes** | no | yes | no |
| **duplicate port id per node** | **yes** | yes | yes | yes |
| **duplicate connection** | **yes** | no | no | no |
| one producer per input | **yes** | no | no | no |
| one source/gain/training binding per lane | **yes** | no | no | no |
| exactly one output / master / cue / time-pitch node | **yes** | no | no | no |
| graph caps: 128 nodes, 256 connections, 16 ports and 64 parameters per node | yes | yes | yes | yes |
| `playbackRate` 0.25..4 | yes | yes | yes | yes |
| `transposeSemitones` −24..24 | yes | yes | yes | yes |
| gain 0..4 | yes | yes | yes | yes |
| beats 2..20000, separation >0.05 s | yes | yes | yes | yes |
| median BPM 30..300 | yes | yes | yes | yes |
| meter ∈ {2,3,4,6} | yes | yes | yes | yes |
| `playback` block required | — | no | no | **yes** |
| `muted`/`solo` required | — | no | no | **yes** |
| `sampleRate` upper bound | 384000 (cue plan) | none | none | 384000 |

The bottom half of the graph column is the part to remember: **the core is the
only thing that rejects a duplicate connection, a doubly-produced input, or a
second master gain** (`materializeNativePlaybackGraphDocument`,
`native_playback_graph_document.cpp`). Only the first has an error of its
own, `NativePlaybackGraphDocumentError::DuplicateConnection`; the second
reports `InvalidConnection` and the third `InvalidBinding`, and both of those
codes cover half a dozen other conditions each, so neither identifies the
rule that fired. A fourth bridge that skipped these checks would cost nothing
at the boundary and everything in the graph compiler.

The desktop's eligibility window is deliberately narrower than the phones':
`playbackRate` 0.5..1.5 and integer `transposeSemitones` −12..12
(`desktop-native-playback.ts`). That is a product decision about which
desktop sessions are allowed onto the native path, not a disagreement about
what the core accepts.

## 10. Product policy that lives in the core

These are decisions a singer can hear, and on the native path they exist only
in C++ — so changing the core changes the product on every platform at once,
silently.

The catch is that **both legacy engines** restate three of them by hand, and
those copies do not move when the core does. The click synthesis appears
verbatim in `src/renderer/src/audio/engine.ts` (`makeClickBuffers`, ~:787-799)
and again in `mobile/src/engine.ts` (`ensureClickAudio`, ~:699-720) — three
definitions of one timbre. The gridless count-in constants
(`SEC_COUNT_TICKS`, `SEC_COUNT_PERIOD`) are in both files too, and both
engines compute the training parity themselves. Change a click constant in the
core and both legacy metronomes keep the old timbre — a difference a singer
hears the moment the backend switches under them. Divergence register entries
10 and 11.

**Click timbre and level** — `native/playback/playback_cue_plan.cpp:23-30`.
Duration 55 ms, attack 1.5 ms, decay 12 ms; ordinary 1046.5 Hz (C6) at
amplitude 0.62, accent 1568 Hz (G6) at 0.9. The envelope is a linear attack
times an exponential decay times a sine (`clickPcm`, ~:246-258). The
metronome `volume` is **not** baked into these buffers: it is applied
downstream in the reference gain, matching Web Audio's buffer-then-gain
ordering.

**The gridless count-in** — `playback_cue_plan.cpp:18-19`, applied at
~:320-347. With no beat grid, a count-in is three ticks per bar one *output*
second apart, and the pre-roll is multiplied by `playbackRate` so the ticks
stay a real second apart at any tempo. A gridless plan carrying downbeats is
rejected outright.

**Tempo and meter admissibility** — `playback_cue_plan.cpp:21-22` and
`isMeter` at ~:36-39. Median (not mean) inter-beat interval must land in
30..300 BPM; `beatsPerBar` must be 2, 3, 4 or 6. A song outside those bands
gets no native click.

**The −1 dBFS safety limiter** — 0.891250938 linear, installed last in the
graph after the output mix, so it bounds the metronome too. It has **two**
definitions in C++, and the one to change is not the obvious one:
`kNativePlaybackLimiterCeiling` (`native_playback_session.h:29`) is installed
by `prepareFixedLegacy`, a source-level parity oracle nothing calls, while
what the product actually renders is a bare literal in the synthesized graph
document (`native_playback_graph_document.cpp:390`,
`{{"ceiling", 0.891250938}}`).

What holds the two together is
`tests/native/native_playback_session_tests.cpp` (~:2386, ~:2604): it renders
through the real prepare and asserts the rendered peak against the constant
within 1e-5, so moving either half alone goes red. There is no TypeScript
implementation. The value appears once on that side, hardcoded in a
`tests/unit/desktop-native-playback.test.ts` fixture that supplies its own
graph document — the one copy nothing pins.
`src/shared/graph-document.ts` and its generated twin carry the
`safetyLimiter` node **type**, not its ceiling. One more warning for anyone
grepping the number: `kMonitorLimiterCeiling`
(`native/electron/audio_monitor_session.h:15`) is the same value in the
desktop input-monitor graph, which is a different graph and out of scope here.

**The two-decode budget** — `kNativePlaybackMaximumConcurrentLaneDecodes = 2`,
`native_playback_session.h:65`, with the measurement that chose it in the
comment above (six five-minute stems: one worker 5163 ms / 881 MB, two
2592 ms / 1097 MB, three 1930 ms / 1308 MB, six 1311 ms / 1940 MB — roughly
211 MB per extra worker). A phone's jetsam budget is the other half of that
argument. The default retention cap is 1 GiB
(`kNativePlaybackDefaultMaximumRetainedBytes`); the phones actually send
1 250 000 000 (`MAX_DECODED_BYTES` in `mobile/src/projects.ts`).

**Odd-period training** — `trainingInside`,
`native_playback_session.cpp:2082-2094`, and identically in
`zdsp/src/runtime/scheduled_gain.cpp`. In period mode, **odd period index
means inside means ducked**; period 0 is heard. Window mode excludes the end
frame. The TypeScript engines compute the same parity in *seconds*
(`Math.floor(pos / periodSec) % 2 === 1`) where the core divides *frames*, so
the two can disagree by one block at a boundary.

## 11. Divergence register

Known, deliberate or tolerated differences. Each is pinned so it cannot widen
unnoticed, and each is a candidate for its own change — none should be
"fixed" as a side effect of something else.

1. **The loop fold disagrees at exactly the loop end.** TypeScript folds when
   `advanced > region.end` (`mobile/src/playback/backend.ts`, ~:404-410); the
   core wraps when `callbackProjectFrame >= callbackLoopEnd`
   (`native_playback_session.cpp`, ~:1152). At the end sample the core has
   already wrapped to the start and TypeScript still reports the end. The
   modulo arithmetic is otherwise identical. Recorded in the agreement
   fixture as a `coreOnly` row; **not** fixed here, because changing the
   projection is a behaviour change and this commit is not.
2. **At-end is exact in the core and approximate in TypeScript.** The core
   completes on `projectFrame >= durationFrames`; both TypeScript facades use
   a 0.01 s epsilon (`parkedAtEndOfSong` in `native.ts`,
   `src/renderer/src/audio/engine.ts`). At 48 kHz that is 480 frames.
3. **iOS hand-rolls the error-name table** while Android and the desktop call
   the core's `nativePlaybackErrorName`. Three copies of one table, and the
   TypeScript fallback (`provider-failure`) differs from the core's
   (`host-failure`).
4. **The desktop declares eight fewer status fields than the addon emits** —
   `graphStatusCode`, `graphStatusDetail`, `timePitchAnchorOutcome`,
   `countInEventCount`, `countInBeatsPerBar`, `laneDecodeFallback`,
   `parkedLaneBytes` and `parkedLaneCount` are absent from
   `DesktopPlaybackStatus`. The phones model six of the eight. The unload
   receipt has the same gap in miniature: it emits four cleanup keys and
   `DesktopPlaybackResult` declares three, `parkedLaneBytes` being undeclared
   anywhere in `src/`.
5. **`ownership` and `activation` are never gated.** The phones publish
   `experimental-4c`; the parser reads the strings and ignores them.
6. **The iOS schema checks fewer duplicates than Android's** — no duplicate
   lane id, no duplicate graph node id. Both are caught by the core, so this
   is an error-message difference, not a safety one.
7. **`unloadPlaybackRetainingLanes` and `playbackLanePeaks` are dormant on the
   desktop** — exported, never called.
8. **Scalar bounds are restated two to four times** — in TypeScript, in each
   bridge schema, and in the core. The agreement fixture pins the values in
   one place; generating them from one source is future work.
9. **`hasReference` is derived three different ways** in the node-count
   predictor: the phones from whether a playback block was supplied, the
   desktop as a hardcoded `true`, the core from whether a cue plan exists.
10. **Both legacy engines restate the click and the gridless count-in** —
    `src/renderer/src/audio/engine.ts` and `mobile/src/engine.ts`. One timbre,
    three definitions, and nothing compares them.
11. **The training parity is computed in seconds by both TypeScript engines**
    and in frames by the core, so the two can disagree by one block at a
    period boundary.
12. **Inbound transport frames are non-negative while outbound project frames
    are signed.** Both are deliberate; together they are easy to misread.

## 12. Changing the contract

1. Change the core first. It is the authoritative row of every table above.
2. Change **all** bridges that publish the affected surface, in the same
   commit. A key added to one is the failure this whole file exists to stop.
3. Update `tests/shared/native-playback-bridge-manifest.json` by hand. It is
   deliberately not generated: regenerating it would let drift fix itself
   silently, which is the opposite of a pin.
4. Update this document, including the divergence register if the change
   creates or closes an entry.
5. Bump `playbackContractVersion` when a wire shape changes in a way an older
   JavaScript bundle cannot read. Adding a key that the parser reads leniently
   is not such a change; removing or retyping one always is.
6. Run everything: `cd mobile && npx jest`, `npm test`, `npm run typecheck`,
   `cd mobile/android && ./gradlew :app:testDebugUnitTest`,
   `bash mobile/scripts/test-native-playback-bridge-schema.sh`, and the native
   ctests.
7. **Mutation-check the new pin.** Delete the key you added from one bridge
   and confirm exactly the intended test goes red. A pin that cannot fail is
   worse than no pin, because it reads as coverage. For native tests, delete
   the object file first — a stale binary passes a test whose source you just
   changed.
