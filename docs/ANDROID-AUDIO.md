# Android audio input

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
`isPreferred` fallback: USB, then wired, then Bluetooth, then built-in. Android
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

## Timing and routing

Oboe's data callback records `CLOCK_MONOTONIC` immediately on entry and advances
its callback-owned stream-frame position. A separate ordinary-priority sampler
calls Oboe's `getTimestamp` while the stream is open and publishes the
hardware frame-position/`CLOCK_MONOTONIC` anchor through bounded lock-free
32-bit atomic reads (including on armeabi-v7a). The callback extrapolates its
first sample in the stream's own frame domain. Until a fresh, sane anchor
exists it falls back to callback entry minus exactly that callback's duration;
`timestampSource` therefore says
`oboe-hardware-monotonic-anchor-with-callback-fallback`. The sampler stops and
joins before stream close, so a timestamp query cannot race handle destruction.
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
