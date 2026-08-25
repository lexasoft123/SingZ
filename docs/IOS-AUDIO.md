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
