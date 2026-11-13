# ADR 0014: Voice strip — recording and monitoring in the song player

Status: accepted; milestone 2 (live monitoring on macOS) implemented on
`codex/voice-monitor`, not merged; milestone 1 and 3 as in the spec table
Date: 2026-11-12 (milestone 2 recorded 2026-11-13)
Origin: issue #136 (input monitoring and recording)

0011–0013 are used by the unmerged DAW branch; this number avoids a clash.

## Decision

Add one **Voice strip** to the song player, beside the stems. It is the first
step toward the DAW session engine (the destination), built from small reviewed
pieces lifted from the DAW branch, never by merging it.

Strip controls: input selector (device, mono channel), mute (= monitoring off,
default), solo, level, record, and a take clip played against the song.
"Lessons" means singing along to a song, not the Train tab.

Backend: **extend SingZ's shared audio service.** The microphone becomes a
first-class client beside song playback. LoopZ stays the Box router. Reasons:

- The shared service already owns the device on desktop and both phones
  (`native/playback/shared_audio_service.*`).
- "LoopZ DSP" is zCore, which SingZ already links. LoopZ adds route documents,
  macOS driver/engine and (unmerged, LoopZ PR #5) a Windows virtual-driver
  preview; it has no iOS/Android code and no time/pitch stage.
- Windows low-latency code (WASAPI IAudioClient3 shared, exclusive,
  latency/suitability reporting) is already in zCore `main`; byte-identical to
  what LoopZ 0.2.1 vendored.

## Product rules (owner decisions, 2026-11-12, applied in M2)

- Latency: target 32 frames, maximum accepted 256 frames. "Frames" is the IO
  buffer at the device rate (step 32, 64, 128, 256). A route whose device
  minimum exceeds 256 is refused as `route-latency`; the control is disabled
  and shows why. Recording and playback work on any route.
- No headphone confirmation (supersedes the ADR 0010 checkbox). A quiet
  first-use hint, "Use headphones to avoid feedback", is not a gate.
- Monitor gain defaults to -12 dB and is remembered. It can be preset while
  off with the "Mon" chip. The fader edits the monitor level while monitoring
  (or in Mon mode) and the take level otherwise.
- Monitoring is never persisted as on. Turning it on arms the input (meter
  live). Toggling during a take never arms; the take holds the input, and
  monitor off mid-take releases only the monitor.
- The strip lists every input channel per device.
- Recording is allowed at any tempo and transpose. A take is recorded against
  the song as heard and plays back as sung, with the settings it was recorded
  under. Following later changes is out of scope.
- Takes are local only for now. Mono only in v1.
- ASIO is not shipped.

## Milestone 2 as built (macOS)

### Design: a second small duplex host, not a bridge

The earlier plan bridged the microphone into the song's output callback. Not
built. The monitor is a **second, small duplex `AudioHost` on the same physical
device as the song output**: selected mic channel in, mono voice, out to the
song's output pair only (L/R). It opens on toggle-on and closes on toggle-off;
the song host is never reopened or drained.

Why not bridged: a full read of LoopZ's macOS code
(`native/core/direct_monitor.cpp`, `monitor_outputs.cpp`,
`docs/latency-comparison.md`) shows 3.9 / 5.2 ms at 32 / 64 frames only with a
same-device duplex host and only with no song in the mix; its bridged path
measured 21–45 ms.

Latency badge: estimated round trip = 2 x buffer + input (latency + safety
offset) + output (latency + safety offset). On the Zen Quadro SC that is about
240 frames, ~5 ms at buffer 32. This is an **estimate, not measured** (needs a
loopback cable).

Unavailable in v1, each with a typed reason from the device inventory
(direction and transport, never labels): separate input and output devices
(built-in mic with another output), Bluetooth or other wireless, no native song
output, and non-macOS platforms (reason `platform`).

### Buffer policy: held for the song session

Differs from the first plan (restore on monitor off). The **song host** performs
the live buffer change once, at the first monitor-on (zCore
`AudioHost::setBufferFrames` with its ledger, opt-in
`allowSharedDeviceBufferChange`). The monitor host opens non-writing at the
current buffer. Monitor off restores nothing. The zCore ledger restores the
buffer when the song session ends: a real song change or switch, route change,
unload, app quit. Same-route graph re-prepares (tempo, transpose, seek) keep the
physical host and its lease. The change is automatic; whether to offer a
per-device persistent monitoring buffer is an open owner decision.

Evidence (MacBook, Zen Quadro SC USB duplex, standalone CoreAudio probe):

- The device IO buffer property is **per process**: a second process changing
  it never affects another process's unit.
- Every in-process period change makes the output callbacks skip about one
  period (a real HAL gap). 50 on/off cycles with restore-on-release lost 1.64 s
  of song time; with the hold, 0.136 s over 50 cycles: one ~512-frame gap at the
  first monitor-on, then ~2.8 ms residual per toggle (source undetermined).
- Audio-process CPU 4.0% with the buffer held (3.8% at 512).

AUHAL facts that shaped the code:

- An input unit re-derives `MaximumFramesPerSlice` (~1.84 x the device buffer)
  asynchronously within ~100 ms of a device buffer change.
- Growth 32 to 512 without a preset slice fails one render with -10874
  (`kAudioUnitErr_TooManyFramesToProcess`), then recovers by itself.
- Chunked `AudioUnitRender` is impossible (-10863). Never call
  `AudioUnitGetProperty` in a render callback. A shrink leaves a ~30 ms callback
  gap.

Consequences built:

- zCore input capture replaces a -10874 block with silence of the same length,
  using the callback's own timestamps, and counts it (`renderSliceDrops`). It
  escalates to failure if it persists (more than 64 consecutive callbacks or
  ~250 ms).
- The take writer pads forward host-time gaps with silence on the writer thread,
  only for Hardware-quality timestamps (macOS). Each block is compared with the
  previous one, so it is immune to device clock drift (a cumulative baseline was
  rejected in review because it drifts with the sample clock). Caps: 2 s per
  gap, 10 s per take, then `gapOverflow` and `partial-error`. Stats:
  `gapPaddedFrames`, `gapPaddedBlocks`, `gapUntrustedTimestampBlocks`,
  `gapRegressions`, `gapOverflow`.
- Verified: a 310 s healthy take pads 0 frames (duration 309.931 s against
  310.000 s elapsed); monitor on/off mid-take completes with true duration (the
  first shrink pads ~30 ms).

### Removed

The ADR 0010 exclusive "Headphone monitoring preview": the Settings section, its
coordinator, the native session and callback, the monitor ownership kind; the
old preference fields are ignored on read. `SharedAudioService::parkOutput`
remains for mobile. ADR 0010 is marked superseded.

### Other platforms

- Windows: zCore's WASAPI host, but the field laptop's shared period is 480
  frames (above 256), so monitoring is unavailable there; ASIO not shipped.
- iOS: one RemoteIO duplex unit, mixing in the callback (future).
- Android: two Oboe streams, bridged by construction (future).

## Milestones

1. **Record and listen back (no live monitoring).** Record on the capture
   delivery sink with raw timestamps. Place takes by capture time minus input
   latency, output latency and graph latency. Play the take joined at the
   output mix with a rate-1 read mode. Local take storage with a sidecar (song,
   start position, latencies, transpose, tempo, match %). Only real-time change:
   one lock-free journal append. Works on all desktop routes.
2. **Monitoring while the song plays, macOS first.** Done on macOS as described
   above (second duplex host, session-held buffer, capture-gap contract,
   preview removed). Windows follows only if a route within 256 frames exists.
3. Takes list per song with match %, "Add to song as track", phones.

## Lifted from the DAW tree (read-only, `daw-native-presentation-20261006`)

| Item | Action |
|---|---|
| `native/playback/presentation_history.*` + test | cherry-pick; wire at `native_playback_session.cpp` slice hook |
| `native/engine/record_clock.*` + test | cherry-pick; add graph latency |
| loopback/drift tools (`singz-audio-host.cpp`) | cherry-pick with measurement spike |
| input beside running output (zCore `audio_input_unit`) | cherry-pick into zCore when needed |
| take writer / recovery / FLAC encoder | re-implement small, reuse format |
| On/Auto/Off gate, record UI | re-implement; lift meter, options, strings |
| input bridge, session engine, recovery adapters | discard |

## Work packages (proposed; package 2 superseded by the design above)

| # | Package | Agent / model | Files | Done when |
|---|---|---|---|---|
| 0 | Spike: macOS + Windows field laptop, legal buffer ranges and round trip at 32/64/128/256 frames with a song playing | e2e-verifier; Codex `gpt-6.1-sol` for harness | dev-flag only | measured table recorded in singz-dev |
| 1a | Port presentation history + record clock + tests | Codex `gpt-6.1-sol` (timing-critical), Sonnet review | `native/playback/*`, tests | tests fail against a deliberate offset control |
| 1b | Take recorder + sidecar + local storage | Codex `gpt-reserve` medium, Sonnet review | `native/electron/*`, `src/main/*` | take longer than 30 s survives restart |
| 1c | Voice strip UI, i18n (EN, RU, zh-CN) | Claude Sonnet | `src/renderer/src/*`, `src/shared/i18n/*` | strip records/plays back in app |
| 2 | Monitoring client (built as the second duplex host) | Codex `gpt-6.1-sol`, Sonnet review | zCore capture/host, `native/playback/*`, zCore pin | real-hardware runs on macOS (done); round trip still unmeasured |

## Open items

Unverified (not covered by the runs above):

- Audible behaviour with a real microphone and headphones (the Zen inputs used
  for verification were silent).
- Measured round-trip latency (needs a short cable, Zen out 1 to in 1).
- Alignment of a take recorded with the monitor on mid-take, measured
  acoustically.
- The ~2.8 ms residual per toggle: source undetermined.
- The real `MacAudioInputBackend` glue and HAL notifications are not covered by
  unit tests.
- Mobile native builds were not compiled (`parkOutput` kept).
- The 12 non-core locale strings are best-effort translations needing native
  review.
- Unpublished zCore commits (346d6a1, d64d1a5, 6045214, 0f66fc1, stacked on
  ca8f131 in the open zCore PR). SingZ, LoopZ and Box must re-pin to the
  same zCore.

Owner decisions still open:

- Per-device persistent monitoring buffer versus the automatic session hold.
- Whether the ~2.8 ms residual per toggle is acceptable.
- Windows ASIO.
- Built-in mic with speakers: warn or refuse? (Not decided; only the quiet
  headphone hint exists.)

Carried from the first plan: rate-1 take playback needs a read mode that does
not exist; macOS capture reports no input latency (zCore fact or measured trim).
