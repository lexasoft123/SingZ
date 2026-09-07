# Android native audio

SingZ captures vocal-training input through the shared native core. On Android
the backend is Oboe (minSdk 28); `AudioInputModule` supplies the endpoint
inventory from `AudioManager`, while `audio_input_android.cpp` owns the stream.
No microphone PCM crosses React Native. The core emits only pitch, confidence,
and level evidence from its ordinary delivery thread.

## Ownership and permission

- The manifest declares `RECORD_AUDIO`, but native code never presents the
  permission prompt. `android-audio-input-session.ts` requests it only when an
  explicit user action passes `requestPermission: true`.
- One owner/generation may capture at a time. The TypeScript coordinator,
  Kotlin module, and native core each enforce that boundary so a stale release
  cannot stop a newer session.
- Device removal ends the lease with an error. Reconnection is a new inventory
  and a new start; SingZ never silently moves a singer to another microphone.
- Capture does not change `AudioManager.mode`, audio focus, communication
  device, or the process route. `react-native-audio-api` remains the playback
  session owner.

## Devices and channels

Portable UIDs are `android:<AudioDeviceInfo.id>`. Android IDs are stable only
inside the connected inventory; the OS may assign a different ID after reboot
or reconnection. A saved UID is therefore a preference, never a durable key.
When it disappears, callers re-enumerate and use SingZ's explicitly named
`isPreferred` fallback: USB, then wired, then built-in, then Bluetooth. Android
does not expose a public active/default capture endpoint, so SingZ does not
label that heuristic as an OS default.

Channel count comes from `AudioDeviceInfo.channelCounts`, channel masks, and
channel-index masks. The policy/forwarding path preserves all 16 lanes when a
USB driver advertises 16, and the stream requests that count before selecting the
requested interleaved lane. This is not a physical-device proof: the Zen and
other multichannel interfaces remain on the hardware matrix. Some vendor
drivers publish no channel metadata. SingZ reports those as mono rather than
inventing inaccessible lanes. The opened device ID, channel count,
selected lane, sample rate, sample format, sharing mode, performance mode and
input-preset status are returned from native negotiation and exposed to JS;
inventory guesses are never repeated as actual values.

SingZ opens ONE stream: low-latency performance requested, the
karaoke-oriented voice-performance preset requested, and sharing mode left at
Oboe's default. These are requests, not guarantees, and the negotiated
metadata reports what was actually granted.

There is deliberately no sharing/preset ladder any more. The old one tried
exclusive (MMAP) sharing with voice-performance FIRST, and fell back only when
an open failed or its negotiated values failed verification — neither of which
silence trips, since it passes both. Exactly wrong for the devices in Oboe's
`QuirksManager` whose MMAP capture opens successfully and then delivers
silence (certain Exynos 9810 builds, without the voice-communication preset).
Letting Oboe gate MMAP per device is the whole reason the backend is Oboe
rather than raw AAudio: that database also covers Exynos 9810/850 running a
mono request in stereo, broken low-latency capture on Exynos 990 and Qualcomm
SM8150. (Its pre-Android-P float-capture workaround is below our floor and
can no longer fire.)
Format and sample-rate conversion are delegated to Oboe for the same reason.

`AAudioStream_getInputPreset` exists from API 28 and minSdk is 28, so the
opened preset is always a read-back and is labelled `*-verified`. Note Oboe
substitutes voice-recognition for voice-performance at or below API 28, so an
Android 9 device honestly reports `voice-recognition-verified`. Unprocessed
and performance presets avoid AGC/effects but can be much quieter — which is
why the analysis adapter normalizes capture before the detector sees it.

One thing Oboe does not do and this backend still does: verify that Android
routed capture to the device that was asked for. Oboe's callers want a
microphone; SingZ lets a singer pick a named one, so a mismatch is a failure
rather than a fallback. Bluetooth SCO, LE Audio,
and hearing-aid inputs are OS-routed and can carry substantial latency or voice
processing; the UI must describe them as high-latency and must not promise
studio-grade timing. SingZ does not force SCO by switching the global audio
mode, because doing so would disturb song playback.

## Dormant paired-stream AudioHost (Phase 3D)

The Android product now packages a standalone `AudioHost` provider for future
graph rendering, but nothing in the app starts it. `react-native-audio-api`
remains the only product playback/session owner; the host does not acquire
focus, change mode, select a communication route, or replace playback and the
metronome. The internal `hasAndroidAudioHostProvider` JNI probe is read-only:
it keeps the provider object in `libsingzcore.so` and lets CI prove the dormant
implementation was packaged without opening a stream.

Java `AudioManager`/`AudioDeviceInfo` remains the authoritative endpoint and
transport inventory. Refreshing it has no audio side effects and only advances
the native route generation when the normalized snapshot changes. A selected
UID disappearing or changing during open/start/render is terminal; the host
never substitutes another endpoint. Bluetooth SCO/A2DP, BLE/hearing-aid and
`TYPE_BUS` automotive routes are classified high latency and never advertised
as monitoring-safe. Built-in, wired and USB endpoint types are the only
explicit low-latency candidates; HDMI and unrecognized vendor endpoint types
remain `Unknown`, which is also not monitoring-safe.
Every valid advertised sample rate is preserved; absent rate metadata remains
unknown rather than being replaced by 48 kHz. Advertised supported rates do
not manufacture an active nominal rate; nominal stays unknown until a stream
actually opens. Failure to publish this dormant host snapshot is isolated
after the existing capture registry succeeds.

The host owns two explicit Oboe streams rather than `oboe::FullDuplexStream`.
This avoids Oboe 1.9.3's paired-stop defect and its unsafe assumption that
multichannel input scratch can be sized from the output. It uses the supported
`shared_ptr` callback APIs. Output opens first at the endpoint's natural rate;
an explicit requested rate must match exactly. Input then opens at the actual
output rate with capacity at least twice the output capacity. Both disable
Oboe callback-boundary format, channel and sample-rate conversion, require float32/low-latency facts,
verify the exact post-open device ID/rate/channel count/burst/capacity/API and
never downgrade requested exclusive access. A named endpoint returning OpenSL
ES instead of AAudio fails closed. The voice-performance input preset uses
Oboe's documented Android-9 voice-recognition substitution and verifies the
post-open value.
These are callback-boundary guarantees, not a claim that Android's mixer, HAL
or device performs no conversion. On API 34+ the separate public hardware
rate/channel/format getters are recorded; on older releases they stay unknown.

Sparse maps request channels through the greatest selected physical index.
The control domain preallocates correctly input-sized interleaved scratch plus
planar graph buses; the callback deinterleaves and interleaves only the exact
indices. Input starts before output. The output callback is the sole graph and
master-clock action and follows Oboe's bounded drain/cushion/discard startup
sequence. A nonblocking input shortage zero-fills, records an xrun and emits a
typed discontinuity; sustained starvation is terminal rather than hidden.
Status reports paired-input capacity, current/minimum/maximum occupancy and
bounded underflow/overflow counters for physical stress evidence.

No allocation, lock, logging, JNI, timestamp query, detector, lifecycle call
or owning-pointer operation is data-callback-reachable. Callback admission and all
callback-visible counters are proven lock-free 32-bit for armeabi-v7a. An
error callback closes admission, marks the pair terminal and reserves teardown
for the immutable pair epoch plus exact failing-stream identity before it
returns `false`, so pinned Oboe 1.9.3 closes the failing stream under its
documented contract. `onErrorAfterClose` queues that exact pair to a serialized
non-audio worker; stale work is rejected before it can load or operate a newer
pair. `onErrorBeforeClose` synchronously stops and joins the ordinary timestamp
sampler before returning, proving that every `getTimestamp`/`getXRunCount`
query has left the raw AAudio stream before Oboe frees it. After Oboe has
closed the failed stream, the worker stops/closes only the retained peer
without reopening or lifecycle-calling the failed stream. The Oboe-retained callback owns
an outer admission/count gate and counts entry before loading its owner. The
owner points to one separately owned control block, never the backend. Public
open/start/stop calls are serialized even across an error-worker handoff, and
one application-operation mutex owns Oboe lifecycle calls; Oboe callbacks
never acquire it. A separate short pair mutex protects only immutable epoch,
identity, phase and teardown-owner transitions and is never held across Oboe
calls or a join. The timestamp owner has an independent mutex plus a monotonic
stopped-through epoch, closing the before-close-before-thread-publication race.
Open is transactional: the newly allocated callback owner and failure field are
initialized before the first `openStream`, and the pair remains `Opening`.
An exact current callback epoch may bind an output/input error before that
stream identity is published; stale callback epochs cannot. Every re-entrant
open/fact/publish step rechecks the epoch, identities, concrete Oboe `Open`
state and sticky callback failure. Pair state and public host state become
`Open` together at one final pair-lock commit, and no late preparation clears a
callback-published failure.
Start uses the same transaction rule. After Oboe reports both concrete streams
`Started`, one pair-lock commit validates the exact identities, route,
admission, sticky failure and a lock-free 32-bit terminal generation, then
publishes pair and public state as `Running` together. There is no later
`Running` store which can overwrite an Oboe error. RT terminal paths never take
the pair lock: they increment the generation before publishing failure and
closing admission. Start captures one immutable generation with bracketed
acquire reads while the pair is still `Open`, before opening callback admission
or calling `requestStart`; a split token snapshot fails instead of adopting a
terminal increment whose failure store is delayed. The commit and final health
gate both require that original token. Control also brackets its final
runtime/admission/route reads with two acquire generation reads, so a terminal
before the second read forces safe error cleanup; a terminal afterward is an
ordinary post-start failure.
User stop waits when Oboe's error sequence already owns that epoch; uncertainty is
published before unlock and re-read after callback drain. The owner is cleared only
after its outer gate drains; rejected or late data entries zero the known
output extent and return Continue. Any uncertain stop/close or drain retains
the complete control block, streams, callback state and coordination worker in
one process-wide fail-stop quarantine instead of risking a late-callback
use-after-free.

`CLOCK_MONOTONIC` input/output timestamps are sampled only by an ordinary
thread; startup `InvalidState` is tolerated. Callback projection uses bounded
32-bit seqlock mailboxes. A fresh output anchor is explicitly marked hardware;
startup/stale anchors use the non-hardware callback-entry fallback and never a
valid zero presentation time. Input, output-buffer, local presentation and external
route latency stay separate. The implementation has clean NDK compile/package
evidence for arm64-v8a and armeabi-v7a, plus host policy/negative-gate tests.
That is not physical evidence: USB channel 3+, unplug/reconnect, sustained
xruns/FIFO occupancy, wired loopback, Bluetooth/BLE/hearing-aid and automotive
tests remain required before product cutover.

## Timing and routing

Oboe's data callback records `CLOCK_MONOTONIC` on entry and end and advances
its callback-owned stream-frame position. A separate ordinary-priority sampler
calls Oboe's `getTimestamp` while the stream is open and publishes the
hardware frame-position/`CLOCK_MONOTONIC` anchor plus its sampling time through
bounded lock-free
32-bit atomic reads (including on armeabi-v7a). The callback extrapolates its
first input sample in the stream's own frame domain. Until a fresh, sane input
anchor exists it uses typed callback-entry fallback. Output render time uses a
fresh hardware projection when available and otherwise a typed, non-hardware
callback-entry fallback; callback time itself is always callback entry, never
projected presentation. Quality transitions and re-anchors are
explicit graph reset boundaries, and callback end records deadline misses;
`timestampSource` therefore says
`oboe-hardware-monotonic-anchor-with-callback-fallback`. Normal stop joins the
sampler before stream close. The error path drains it synchronously inside
`onErrorBeforeClose`; only after that function returns may Oboe destroy the
failed handle and invoke `onErrorAfterClose`. The exact-pair worker then owns
only peer stop/close, so a timestamp query cannot race handle destruction.
Every raw ring block additionally carries `Hardware` or `CallbackEstimate`
provenance. The bounded 2048/512 native adapter tracks sample positions from
that anchor, resets and re-anchors on either provenance transition, and emits
aligned window start/end timestamps plus the resulting `timestampQuality`.
No analysis window can mix callback-estimate and hardware-anchor samples; a
temporarily stale anchor causes the same deliberate reset as initial hardware
acquisition.
Nanoseconds travel as decimal strings because they exceed JavaScript's safe
integer range. Output-route compensation remains separate in `AudioRouteInfo`:
it labels and caches the actual playing probe `AudioTrack.routedDevice` (A2DP,
HFP, BLE, hearing aid, USB, or automotive/bus), never the highest-priority
connected device. A null routed device is reported as unknown. A measured
presentation queue is the complete automatic output delay; the AudioManager
buffer property is used only when that probe is unavailable, so the shared
latency sum never counts the track/HAL buffer twice. Output latency is never
added to capture samples or capture timestamps.

The real-time callback performs only an entry clock read, format
conversion/deinterleave into a preallocated mono buffer, and a lock-free SPSC
push. It allocates no memory, takes no locks, uses no JNI or logging, and runs
no detector. A lock-free admission counter is closed and quiesced before stream
destruction. Resampling, the fixed-size analysis window, pitch analysis, React
events, and error messages happen on ordinary threads. If Android cannot create
the eventfd wake or `poll` fails, delivery retains its bounded timed wait instead
of spinning.
