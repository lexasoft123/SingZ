# iOS low-latency audio input

The shared `AudioInput` pipeline uses an iOS-specific RemoteIO provider. It
publishes one selected physical input lane as native-rate mono float32 blocks,
using the same preallocated SPSC ring and delivery thread as macOS and Windows.

## Session and route selection

`AVAudioSession` is process-global and react-native-audio-api already owns it
for SingZ playback. The C++ provider therefore never changes its category,
mode, options, activation, preferred input, sample rate, channel preference,
or buffer duration. `ios-audio-input-session.ts` serializes a temporary
capture lease through the library's public `AudioManager`: it
checks/requests permission, explicitly deactivates the library-owned session,
chooses `playAndRecord` plus measurement mode, reactivates, then selects the
input. Deactivation matters because AudioManager otherwise tries to apply
changed options while active without surfacing the configuration error. A
read-only native check verifies the exact category, mode and options after
reactivation.

After AudioManager selects the input, the same serialized bridge workflow
waits for that route UID, requests the route's
`maximumInputNumberOfChannels`, and waits for the negotiated count to expose
the selected zero-based lane. This is what makes channel 3 and higher usable
on multichannel USB devices. It also requests a 5 ms preferred I/O buffer on
local/wired routes. It deliberately leaves the buffer preference alone for
Bluetooth, AirPlay and CarPlay routes, whose transport latency dominates and
whose callback duration is route-controlled. These are temporary capture
preferences: their previous values are tokenized and restored before the
session returns to playback, including failure paths.

Release invalidates the native lease, restores channel/buffer preferences and
the previous input while the capture category is still active, then
deactivates and puts the public owner back into SingZ's
`playback`/`default` session. A second read-only check verifies that exact
playback configuration and an active output route. If restoration fails, the
coordinator reports the complete set of failures but still finishes the
playback transition. If a disconnected route prevents preference cleanup,
native bookkeeping is abandoned only for the matching token
and only when the active/available input inventory proves that saved UID is
gone; an old token cannot touch a newer capture. A present route or an
inconclusive inventory keeps transient channel or global buffer restoration
retryable. Failure to release the native lease, failure to restore or safely
abandon capture preferences, or any playback transition/activation/read-only
verification failure retains a recovery latch, rejects new capture, and
permits an explicit retry instead of allowing native tokens or sessions to
overlap.

The native lease's process-wide route generation binds it to the exact route
that AudioManager prepared. Token, generation, UID and minimum channel count
are committed under one non-real-time mutex, so an old delayed release cannot
clear a newer lease.
The backend installs observers before its first readiness snapshot and
revalidates the generation, permission, category, active input, sample rate,
channel count and selected UID after setup and before/after start.

RemoteIO's channel map selects exactly one zero-based hardware lane, including
lanes on multichannel USB interfaces. Only the active input is reported with
the session's negotiated sample rate; inactive ports use rate `0` (unknown)
rather than falsely inheriting the current route's value. HFP, CarPlay, USB,
and other accessories may negotiate materially different rates and callback
durations. The actual active rate is returned by `AudioInput::start`.

## Timestamp and route-latency contract

When RemoteIO supplies a nonzero `kAudioTimeStampHostTimeValid` timestamp,
`sampleHostTimeNs` is that unmodified input-buffer host time and the raw block
is marked `Hardware`. `callbackHostTimeNs` is captured with
`mach_absolute_time()` immediately on callback entry, before
`AudioUnitRender`. If RemoteIO omits or invalidates its host time, the first
sample is estimated as callback entry minus the buffer duration and the block
is marked `CallbackEstimate`; it is never mislabeled as hardware. The shared
analysis adapter resets on either provenance transition, so no window mixes
the two timelines. Both timestamps use the same monotonic clock. The capture provider never subtracts
`AVAudioSession.inputLatency`, adds output latency, shifts samples, or changes
timestamps to make a delayed speaker appear earlier.

Output delay is a different concern. The existing `AudioRouteInfo.getOutput`
bridge reports `outputLatency`, `ioBufferDuration`, output port type, name and
UID. The UI combines that metadata with its per-route trim for Bluetooth and
CarPlay lyric/visual compensation. It must not apply that compensation to raw
microphone buffers or pitch-analysis timestamps.

An interruption, media-services loss/reset, or any audio-route change ends the
current capture with an explicit restart error. This creates a discontinuity
boundary instead of joining blocks that may have different sample rates,
channel order, or callback cadence. The caller re-enumerates devices and
starts a fresh stream after the route settles.

## Permission contract

`NSMicrophoneUsageDescription` is present in the application plist. The C++
provider and native lease bridge never request permission. The coordinator
uses AudioManager's public `checkRecordingPermissions()` and calls its public
`requestRecordingPermissions()` only when `requestPermission: true` came from
the user-initiated vocal-training flow. An undetermined or denied permission
otherwise fails before any session mutation.

## Real-time constraints

The RemoteIO callback owns a buffer allocated during `open`. Steady-state work
is limited to `AudioUnitRender`, two host-clock reads, atomics, a bounded copy
into the portable ring, and a Mach semaphore signal. It performs no allocation,
locking, logging, Objective-C messaging, JSON conversion, or pitch analysis.
Session notifications only set atomic flags and are consumed on the ordinary
delivery thread.

The simulator can prove compilation and lifecycle wiring, but not microphone
route enumeration, channel mapping, Bluetooth/CarPlay behavior, or latency.
Those require a physical iPhone or iPad and the intended accessories.

## Product packaging checkpoint (Phase iOS-A)

The iOS application now statically links the callback-safe `zdsp_runtime` and
`AudioHostGraphAdapter` through the dedicated `SingzDspRuntime` component pod.
Its source list is the exact CMake runtime/adapter list, compiled privately as
C++20 with `SINGZ_REALTIME_LEAF=1`, exceptions and RTTI disabled, and hidden
visibility. It has no React Native, codec, ONNX Runtime or Apple audio-session
dependency. Top-level `zdsp/` and `zcore/` remain authoritative; postinstall
materializes a read-only, ignored copy from an explicit allowlist, and CI
checks that the copy is byte-current.

`SingzCore` still packages the existing capture/media/analysis compatibility
surface, but no longer compiles the graph contracts or decoded-buffer/runtime
translation units. This gives every graph symbol one iOS product owner without
widening the compatibility pod's glob.

The callback path underneath the host is isolated as well. The dedicated
`SingzDeviceCallback` pod owns the exact CMake `zcore_device_callback` target
membership plus the iOS RemoteIO callback source/header. `SingzCore` retains
device inventory, session, lifecycle, worker, media and analysis ownership but
no longer compiles those callback definitions. The callback pod applies C++20,
the real-time and iOS callback compile markers, no exceptions/RTTI and hidden
visibility to every source through a compile-asserting prefix guard. Archive
gates reject exception personality/C++ ABI support, product/control
dependencies and exported C++ definitions while allowing the required
AudioToolbox render import.

`mobile/scripts/native-component-sources.js` is the iOS materialization
manifest. Before syncing, `check-native-component-sources.js` parses the four
CMake memberships (`zdsp_runtime`, `zdsp_host_adapter`,
`zcore_device_callback`, the iOS AudioHost callback pair and the native
playback callback/session targets) and compares normalized sets exactly. Any
source added or removed on either side fails; recursive pod globs see only
that closed generated set.

Phase iOS-A initially exposed only `NativeAudioRuntime.status()`. The probe
still holds typed references to each runtime boundary so a successful final
app link and binary literal/symbol check prove that the implementation reached
the app rather than merely leaving an unused archive beside it. Phase iOS-B1
added the generation-bound playback commands described below.

Phase iOS-B2 now has one deliberately narrow product consumer:
`mobile/src/playback/native.ts`. It is default-off behind the Experimental
iPhone setting and owns only eligible WAV/FLAC, frame-zero, no-parity-feature
projects. The coordinator selects the backend before decode, creates no
RNAudioAPI song buffers on the native path, suspends legacy output before
configuring/opening RemoteIO, and requires an exact process-global cleanup
lease before any lazy legacy fallback. RNAudioAPI remains the normal/default
song and metronome backend; Android remains unchanged. Physical-device
listening and route, interruption, buffer and latency evidence remain release
gates. The PR canary links and inspects the dead-stripped Release iPhone
executable, in addition to arm64 device and universal arm64/x86_64 simulator
archives for both strict components.

## Native playback session foundation (Phase iOS-B1)

`NativePlaybackSession` is a reusable control-domain owner, packaged in the
exact-source `SingzPlaybackSession` pod. It consumes only already-authorized,
already-opened `OwnedFileDescriptor`s; the React Native bridge opens regular
files beneath the app's Documents, Application Support or bundle roots with
`O_NOFOLLOW`, validates the canonical opened path, then transfers descriptor
ownership. The raw descriptor is wrapped in `OwnedFileDescriptor` immediately
after `open(2)`, before canonicalization, root checks, error construction or
any other allocating work. WAV/FLAC decode, optional common-rate resampling,
cancellation and
aggregate retained-byte accounting all complete before the graph or output
host is published. Preparation performs no `AudioHost` enumeration, open,
configuration or start operation and is safe while RNAudioAPI still owns the
product output. It captures an exact route intent supplied by B2; only the
separate `openOutput` command re-enumerates and validates that intent before
opening RemoteIO.

The prepared graph is sample-locked and starts only at frame zero:

```text
decoded lane -> channel map -> ramped lane gain --+
decoded lane -> channel map -> ramped lane gain --+-> mix -> master gain
                                                      -> -1 dBFS limiter -> output
```

Mute and solo resolve into each lane's gain processor. Unequal lane ends emit
silence independently while the remaining lanes continue. Decoded owners stay
alive until host stop/quiescence, runner retirement and graph deactivation have
completed, then release deterministically. An uncertain host stop fails closed
and quarantines the graph instead of freeing callback-visible state. Status
retains rendered and audible frames, each lane cursor, retained bytes, xruns,
deadline misses, discontinuities, render diagnostics and a typed terminal
route/interruption/media-services reason. The callback has a strict
no-allocation/no-lock policy and is built into `SingzDspRuntime`. A render
failure pre-silences the block, latches `RenderUnavailable`, increments a
bounded terminal counter and permanently prevents graph re-entry for that
session. Every notification, provider and graph-callback cause receives a
lock-free monotonic ordinal at publication. Each producer retains its exact
earliest `{ordinal, reason}` in one packed atomic minimum, so a delayed first
publisher cannot lose its reason after later publishers exceed the former
journal capacity. Publication has a statically bounded number of atomic
attempts, never allocates or spins, and the wait-free ordinal allocator keeps
a conservative 64-publisher in-flight headroom before true exhaustion rather
than wrapping. Ordinary contention therefore cannot poison future generations
into saturation; the same bound is enforced by atomic admission on ordinal
allocation and every retain. Admission uses bounded compare/exchange and
refuses saturated or corrupt counters without a transient increment/rollback,
so even `UINT32_MAX` cannot wrap through zero. A rejected retain publishes a
coherent packed cause into a separate bounded fallback that participates in
`current()` and `hasCause()` immediately, even while all 64 admitted writers
are paused before their primary publication. Status compares producer-stamped ordinals so
the temporal first cause survives even when several domains fail before the
control thread samples them. Host and callback facts are folded into one
first-cause locked `Terminal` state used by status and command admission. The
retained cause is orthogonal to the provider's physical `Stopped` quiescence
proof, so
unload can retire owners after a terminal event without erasing why it stopped.
The session latch resets for a newly prepared generation. The provider latch
resets at the boundary of each admitted open attempt (after the previous host
is physically stopped), so an old generation's retained cause cannot be
attributed to a new attempt even when that new open fails. The
session pod owns only the off-callback composition and therefore cannot
duplicate the callback definition.

Generation claims are immediate rather than queue-bound. A newer claim
cancels an older decode and is linearized with final prepared-graph
publication. `stop` and `unload` advance the matching cancellation epoch
before their serialized command is enqueued, so a long decode stops promptly.
Once a newer generation is claimed, the old generation cannot open output,
start or change controls, but its exact `stop`/`unload` remains legal for
cleanup. Split-word source cursors use bounded verified retries and retain a
control-domain last-good snapshot; they never return an unverified pair.

### Frozen bridge contract for Phase iOS-B2

The experimental `NativeAudioRuntime` surface is fixed as follows. All generation
values are positive exact JavaScript integers. Malformed schemas reject with
`E_NATIVE_PLAYBACK`; valid operations always resolve a typed result, including
ordinary session failures.

- `status()` returns `available`, `buildId`, `graph`, `audioHostAdapter`,
  `playbackSession`, `playbackBuild`, `ownership: "coordinated"`,
  `playbackCleanupProof`, `playbackHandoffLease`,
  `activation: "experimental-b2"`, read-only `outputs`, and `session`
  telemetry.
- `prepare(generation, request)` accepts one to sixteen
  `lanes: [{id, path, gain?, muted?, solo?}]` plus required exact
  `outputDeviceUid`, zero-based `outputChannels` below the native host channel
  limit and integer `sampleRate`;
  `maximumFrames`, `bufferFrames`, `masterGain` and
  `maximumRetainedBytes` are optional. `handoffLease` is an optional positive
  exact JavaScript integer used only for atomic fallback-to-native reentry.
  The bridge parses it before synchronous generation claim. It
  decodes/resamples and compiles the graph only. It performs zero host
  operations and never mutates `AVAudioSession`.
- `configureOutputSession(generation)` runs on the same serialized native
  control queue and accepts only the exact, uncancelled `Prepared` generation.
  It applies `playback` category, `default` mode, zero category options and
  activates `AVAudioSession`, then re-reads category/mode and the current
  route. Success requires the prepared output UID, every prepared channel and
  the exact sample rate still to match. Ordinary configuration or verification
  failures resolve a typed result; malformed generations and bridge-boundary
  exceptions reject. It never opens RemoteIO, and `prepare` remains free of
  platform-session mutation.
- `openOutput(generation)` re-enumerates the current route, requires the exact
  prepared UID/channel/rate intent, and opens the output-only host. Failure
  leaves decoded media and the prepared graph intact for an explicit retry or
  `unload`; it never starts rendering. The provider may safely clamp its
  actual maximum callback size below the prepared maximum, provided it remains
  non-zero and no smaller than the negotiated nominal buffer size.
- Output-open and start host-mutation markers are persistent physical
  ownership facts, cleared only after provider quiescence is confirmed. They
  are distinct from one-shot command-delivery tokens. A command receives an
  exact `{generation, serial, kind}` token only after its preconditions pass
  and native host mutation is admitted. The bridge acknowledges that token
  only after promise delivery returns; a conversion/delivery exception aborts
  only the exact unacknowledged token. Duplicate, stale, wrong-kind and
  already-acknowledged tokens are inert, so a duplicate same-generation
  command cannot tear down an already-valid stream. A merely prepared
  generation has no physical marker: its stop/unload never samples or stops
  the provider and cannot inherit a prior generation's terminal cause, format
  or counters.
- `start(generation)`, `stop(generation)` and `unload(generation)` act only on
  the matching prepared generation. Start is legal once and only while every
  lane cursor is zero; there is no restart/seek masquerading as start. Start
  remains `output-open` while the provider starts, then publishes `running`
  only if generation, cancellation, callback-terminal and host-health checks
  still pass. A failed check stops the provider before returning.
  Stop and unload also keep an exact-generation delivery guard from their
  synchronous cancellation claim through GCD block transfer, result
  conversion and promise delivery. An exception retries cleanup for that
  generation only; a newer generation is never stopped by the retry.
  Normal `unload` resolves the ordinary playback result plus a nested
  generation-exact `cleanup` proof: `safety`, `error`, `generation`, `state`,
  retained bytes, physical ownership, process-quarantine reservation/poison/
  retained bytes, terminal reason, coordinator state/epoch/owner facts,
  `handoffLease`, `globallyComplete` and `fallbackSafe`. Local unload success
  is not ownership proof. `globallyComplete` and `fallbackSafe` are true only
  while the returned positive `handoffLease` holds the process coordinator in
  `fallback-leased`; there is no empty-snapshot race window.
  Results are held in a bounded, allocation-free exact-command receipt
  journal. If unloading an older graph also completes an already-requested
  newer-generation unload, the root result remains attributed to the older
  command while nested `cleanup.generation` identifies the newer owner and
  carries its lease or uncertainty. Retrying the older command after promise
  delivery failure returns the identical receipt; asking cleanup proof for
  the old generation remains `NotOwned`. Journal exhaustion fails closed.
- Every completed failed `prepare` publishes `unloaded`, generation zero and
  zero retained bytes, while remembering its failed generation for cleanup.
  Matching `unload(failedGeneration)` succeeds idempotently and releases the
  pre-reserved fail-stop slot; B2 must perform that handshake before retrying
  or entering the lazy legacy fallback.
- If the bridge has claimed a generation but opening or authorizing any lane
  descriptor fails, it resolves a typed `decode-failure` through the same
  failed-prepare admission. Matching `unload(generation)` remains mandatory
  and idempotent.
- `setControl(generation, {laneId, gain, muted, solo})` updates one complete
  lane state; `setControl(generation, {masterGain})` updates the master.
- Command results contain `ok`, `error`, `generation`, `state`, negotiated
  `sampleRate`, `maximumFrames`, `nominalBufferFrames`, `outputChannels`, and
  `message`. Session status additionally exposes host/session state, terminal
  reason, counters, latency classes, lane cursors/lengths and controls.

The B2 product coordinator selects the feature-gated backend **before project
decode**. A native-selected load materializes authorized lane paths and calls
`prepare`; it never creates or retains RNAudioAPI `AudioBuffer`s for that
song. Existing player-route ownership runs `engine.unload()` and
`releaseProject()` before a different project is admitted, so legacy PCM is
not retained beside a native song. If native prepare fails, B2 calls matching
`unload` and requires both
`cleanup.globallyComplete === true` and a positive `cleanup.handoffLease`
before lazily decoding a legacy fallback. Legacy owns output/PCM only while
that process-global lease remains held. This order prevents the observed
509–659 MB decoded projects from existing twice.

For native reentry, B2 first suspends and releases legacy output while it
still holds the fallback lease, then calls the next
`prepare(generation, {..., handoffLease})`. The synchronous bridge claim
atomically validates and consumes that exact token into
`native-owned(session,generation)` before any descriptor work or decode.
Missing, stale, wrong and replayed tokens reject without changing the held
lease. A fresh process in `available` may claim without a token; while any
fallback lease is held every tokenless claim is rejected.

After native preparation, the one serialized product lease suspends/retires
legacy output ownership, calls `configureOutputSession` to establish and
verify the intended `AVAudioSession`, calls `openOutput`, then calls `start`.
It reverses that ownership sequence on stop or failure and guards asynchronous
results by both the Catalog load token and native generation. Prepare and
pre-start open failures may fall back only after the exact cleanup proof;
there is no automatic fallback after `start` is invoked or after a terminal
route. Seek, pause, loop, metronome, tempo, transpose, custom codecs and
non-zero starts are intentionally unavailable in the B2 player. Stop obtains
a lease, and the next Start re-prepares the same song at frame zero.

The Train tab uses the same ownership barrier: its tab press is held until
native stop/unload proves the fallback lease. The Training scene remains
inactive, so neither microphone capture nor reference cues may configure an
audio session while native output ownership is uncertain.

Every bridge dictionary is an exact schema. Unknown keys, `null`, wrong
nested collection/string types, numeric `CFBoolean` values, and non-Boolean
NSNumber values in Boolean fields reject with `E_NATIVE_PLAYBACK`. Unpaired
UTF-16 surrogates and embedded U+0000 are rejected for every UID, lane ID,
path and control ID, so filesystem authority cannot be validated under one
string and opened under a silently truncated one. No
Objective-C coercion or silent default is used. A Foundation-native malformed
payload matrix runs in the iOS canary.
Foundation/C++ allocation failures at the bridge resolve no partial result:
they reject as `E_NATIVE_PLAYBACK_RESOURCE_EXHAUSTED`; every other exception
is contained and rejects as `E_NATIVE_PLAYBACK_PROVIDER`. Ordinary decoded
memory limits remain the typed result `limit-exceeded`, distinct from resource
exhaustion. A prepare ownership guard becomes active immediately after the
generation claim. The claimed guard and transferred shared-block guard both
live outside the caught outer boundary, so allocation, capture construction,
real block-copy or dispatch exceptions cannot destroy the active guard and
discard its cleanup verdict. Exceptions before session mutation complete
failed admission and its matching exact unload; exceptions after mutation
synchronously cancel and unload the exact generation before rejection,
including result-dictionary and promise-delivery failures. Any `Complete`
verdict requires every global owner to be absent: no decoded graph, current or
active session generation, failed-prepare handshake, physical/invocation
marker, pending command token, or quarantine reservation. `openOutput` and
`start` use exact one-shot
delivery tokens separate from persistent physical ownership. Native writes a
token at the mutation boundary so C++ or Objective-C exceptions after hidden
provider acquisition remain recoverable; a precondition failure writes none.
Cleanup is itself a C++/Objective-C nonthrowing boundary and returns a stable
verdict. `NotOwned` means only that one exact token/generation has no cleanup
claim; it is never evidence that another generation or output owner is gone.
Only `Complete` together with global `unloaded`, zero retained bytes, no
physical host marker and an **Available, empty process-wide quarantine slot**
is fallback-safe. A slot reserved by another native playback session or a
Consumed/poisoned graph makes every local cleanup proof non-global; bridge
error facts expose the reservation, poison state and process-quarantined
retained bytes. Block-copy, result-conversion,
pre-resolve and promise-delivery exceptions after `stop` or `unload` use the
same exact-generation retry and proof. `teardown-uncertain`, `NotOwned`,
quarantine, retained decoded bytes or an unproven host stop reject as
`E_NATIVE_PLAYBACK_TEARDOWN_UNCERTAIN` with
generation/state/retained-byte/terminal/physical-ownership and process-
quarantine details. B2 must
not lazily decode legacy PCM or resume another output owner until it receives
the complete global proof.

A decoded graph that loses the final prepare-publication race remains an
explicit retiring owner while shutdown runs off the session locks. Its exact
generation, retained bytes, prepare mutation marker and process reservation
remain published until runner shutdown, graph deactivation and decoded release
finish. Concurrent unload records exact-generation intent but its cleanup proof
is `uncertain` until retirement completes; a newer prepare cannot acquire the
reservation in that interval. Successful retirement completes a recorded
unload atomically. Failed retirement consumes that same reservation into the
bounded process quarantine without republishing the stale graph into newer
session state.

## RemoteIO output host (Phase 3C, activated experimentally in iOS-B2)

`AudioHost` has an iOS RemoteIO provider. The default product path remains
`react-native-audio-api`; the Experimental B2 coordinator is the only product
caller and may open the host only after its explicit legacy-output suspension
barrier. Merely enumerating the host reads the active route and never opens an
AudioUnit or mutates the session.

The provider accepts output-only configuration (empty input UID and map), or
duplex configuration using the active input and output routes from the same
already-prepared `AVAudioSession`. iOS input and output ports have distinct
opaque UIDs. Duplex does not require their strings to match; instead it
requires the existing capture lease's UID, route generation and minimum
channel count to cover the input selection. The one RemoteIO instance and
session provide the common clock, and only its output render callback invokes
the graph.

The render callback's hardware timestamp is retained as the output/master
anchor. `AudioUnitRender` does not return a separate input-buffer host anchor
in this topology, so duplex capture publishes a callback-entry estimate for
its first sample and explicitly marks it non-hardware. Sharing the RemoteIO
clock domain is not permission to relabel output presentation time as raw
capture time.

The session owner must configure and activate the intended route before
`open()`. The provider validates and snapshots category, mode, options, route
generation, opaque port UIDs, exact negotiated rate/channel counts,
`IOBufferDuration`, input/output latency and the capture lease. It rejects a
requested rate or buffer that differs from those negotiated facts. It never
calls any `setCategory`, `setMode`, `setActive`, `setPreferredInput`, sample
rate, channel-count or buffer-duration API.

Physical output maps are destination-sized: unselected hardware lanes are
`-1`, while each selected destination points to its planar graph source.
Input maps contain the selected zero-based physical input lane for each planar
graph destination. RemoteIO performs its own device-format conversion; the
graph boundary itself is always non-interleaved float32. Duplex input storage
and its `AudioBufferList` are fully allocated during `open()`, while output is
rendered directly into RemoteIO's planar buffers.

The latency result deliberately keeps four values separate:

- `inputDeviceFrames`: `inputLatency` converted at the actual session rate;
- `outputDeviceFrames`: local/wired/USB/HDMI `outputLatency`;
- `bufferFrames`: actual `IOBufferDuration` at the session rate;
- `externalRouteFrames`: Bluetooth/AirPlay/CarPlay `outputLatency`.

This split prevents a transport delay from being presented as low-latency
hardware. Product audible projection still follows the route-latency snapshot
rule (`outputLatency + IOBufferDuration`) and must not add either component
twice.

Observers are installed before the opening snapshot. A route change,
interruption, media-services loss or reset advances the generation, causes the
render callback to output silence, and exposes a terminal status requiring an
explicit stop/open. No default device or format is substituted. The callback
contains only host-clock reads, layout bounds checks, optional
`AudioUnitRender`, planar buffer writes, atomics and the graph thunk; it makes
no allocation, lock, Objective-C/session call or log.

Callback admission closes before stop. Its accepting bit and admitted count
share one lock-free 32-bit state, so close either observes a previously
admitted callback or prevents its admission; teardown cannot observe a false
zero across two atomics. After a successful `AudioOutputUnitStop`, the control
owner waits for the provider gate, graph endpoint and outer callback-entry
counter before uninitializing or disposing RemoteIO. If stop fails, it does
not uninitialize or dispose through uncertain callback activity: the live unit
and closed callback context enter the bounded fail-stop quarantine after every
previously admitted callback has returned. Callback layout failures are sticky:
every later callback remains silent until an explicit stop/open. A duplex
input pull uses its own action-flags word, so an input `PostRenderError` zeros
the input block and records an xrun without corrupting the outer output flags;
the outer `OutputIsSilence` bit always describes the final graph result.
Because `AVAudioSession` is process-global, the standalone provider admits one
RemoteIO host owner at a time. If stop or component disposal fails, a bounded
one-slot fail-stop quarantine retains the unit and closed callback context and
poisons further opens for that process; it never grows with retries or
releases state that CoreAudio might still reference.

The output timeline remembers timestamp validity and the next expected
`mSampleTime`. Validity transitions and non-contiguous sample positions emit
typed reset boundaries before the affected graph block, as required by ADR
0003; missing timestamp fields are never silently treated as a continuous
hardware anchor.

Deterministic policy tests run without an iOS device. The isolated Apple build
compiles and link-checks arm64 iPhone and arm64/x86_64 simulator slices, and
checks that the provider imports RemoteIO but no AVAudioSession mutation
selector, including preferred channel counts, port override, multichannel,
session and route-child data-source/polar-pattern setters, aggregate-I/O and
intended-spatial-experience setters, legacy hardware-rate/delegate setters,
input/output muting, both record-permission request APIs and microphone-
injection permission. This is compile/ownership evidence only. A physical
iPhone must still provide loopback
latency, callback distribution, multichannel USB, sustained xrun/deadline,
interruption and Bluetooth/CarPlay route-change evidence before product
playback can cut over.
