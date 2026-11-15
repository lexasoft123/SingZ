# ADR 0011: Box song clock domain

Status: proposed<br>
Date: 2026-11-15

## Question

How should the Box song reach the physical output so that playback quality does
not degrade with audio-host uptime?

## Context

ADR 0003 makes the output device clock the graph master and reserves a bounded
FIFO plus a variable-ratio resampler for *different* endpoints. The Box routing
host does not follow that rule for its own song. With `SINGZ_BOX_LOOPZ_ROUTING`
the shared player is given a driverless backend instead of the platform output
(`native/playback/box_routing_owner.cpp:381-382`), and the song then crosses
three pacing loops and two timestamp-addressed resampling reads:

1. **Song producer, CPU clock.** `native/playback/loopz_source_backend.cpp:140-205`
   runs a thread that sleeps on `std::chrono::steady_clock` (`:42`, `:153-154`),
   renders one 256-frame block and appends it to a `loopz::AudioHistory` stamped
   with the *scheduled* production time (`:194`). The block is explicitly not a
   presentation timestamp and not a clock master (`:174-178`). A wake more than
   2 ms late re-anchors the schedule and marks a discontinuity (`:159`, `:198-203`).
2. **Scene renderer, CPU clock.** LoopZ's mix thread derives its frame counter
   from the monotonic clock (`third_party/loopz/native/core/render_schedule.cpp:23-53`,
   `third_party/loopz/native/runtime/audio_runtime.cpp:698-732`). It reads the
   song history at `frameNs(frame - latency)`
   (`third_party/loopz/native/core/audio_scene.cpp:431-432`) and publishes the
   mixed bus into a second history stamped `frameNs(firstFrame)`
   (`third_party/loopz/native/core/monitor.cpp:42`). The producer grid and the
   scene grid have an arbitrary sub-sample offset, so this read is a fractional
   sinc interpolation even though both sides are nominally 48 kHz.
3. **Physical output, device clock.** The ALSA worker estimates the presentation
   time of each period as status timestamp plus `snd_pcm` delay
   (`third_party/zcore/zcore/platform/linux/alsa_pcm.cpp:55-73`,
   `audio_host_linux.cpp:345-352`). `EstimatedOutputTimeline`
   (`audio_runtime.cpp:501-564`) smooths it with an alpha-beta servo whose only
   error term is observed minus projected timestamp, bounded to +/-0.5 % and
   reset on a 2 ms error. The monitor reads the bus history at that time minus a
   fixed budget, at the measured rate (`monitor.cpp:173`, `:199`).

The budget is queued output + period + filter future + scheduler reserve, rounded
up to a block (`audio_runtime.cpp:452-481`): 1024 + 256 + 103 + 256 -> 1792 frames
on the reference interface. Lyric presentation adds the scene lookback to it
(`box_routing_owner.cpp:261`, `:283`), so the song is heard roughly 2816 frames
(59 ms) after it was rendered. The history, clock map and resampler exist twice
in the tree: LoopZ's own copies (`third_party/loopz/native/core/`), which the
Box links for these paths, and the zCore adaptation
(`third_party/zcore/zcore/src/routing/`).

Position in every history is addressed purely by timestamp
(`third_party/loopz/native/core/sample_clock.cpp:99-193`). Nothing measures the
distance between what was published and what is being read, except optional
diagnostic counters. Read delay is correct only while every timestamp in the
chain is unbiased.

**Why it was built this way.** LoopZ is a generic any-source-to-any-device
router (apps, interfaces, virtual devices, several monitors, independent
clocks). The Box integration consumed it unchanged so that routes persist and
survive UI restarts, the song can fan out to more than one output (optional
HDMI audio), a separate-interface microphone can be mixed in software, and
private microphone analysis can borrow a capture without a second device owner
(`docs/ARCHITECTURE.md:29-39`, `docs/specs/singz-box/loopz-integration.md`).
A history source was the only extension point LoopZ offered: "register a fixed
stereo `native:singz` source ... feeds a bounded native AudioHistory". No
document states a reason for the song to be clocked by the CPU; it follows from
the source API, not from a requirement.

The default appliance does not need the generality. Its topology is USB song
playback into one interface, *hardware* microphone monitoring on that interface
and analog main out; same-interface software microphone returns are rejected
(`loopz-integration.md`, "Goal and boundary", "Initial implementation boundary").
In the default route the song has exactly one destination, on one clock.

## Evidence

- A Box field unit whose persistent audio host has run for about 24 h plays
  music described first as "fuzzy and lower", later as "robotic, quieter, with
  digital noise and missing frequencies". Restarting the audio host restores
  normal sound; the fault returns after roughly another day.
- Telemetry stays clean throughout: xruns 0, deadline misses 0,
  discontinuities 0, playback rate 1, transpose 0, no clipping.
- Phone recordings of the same song section, bad host versus fresh host,
  compared with the exact non-vocal stem mix. Cepstral peak/median at delays of
  256 / 512 / 768 / 1024 samples: bad 1.95 / 1.61 / 1.30 / 0.93; fresh
  1.40 / 1.02 / 0.91 / 0.75; stems 1.36 / 1.07 / 0.96 / 0.77. The degraded output
  therefore contains copies of the signal delayed by exactly one to three device
  periods (256 frames at 48 kHz; ALSA period 256, buffer 1024). It also loses
  about 4 dB at 2.5-8 kHz and 3-8 dB above 8 kHz. Speed is correct.
- Counters are 64-bit, and translating their origin (3e9, 4.07e9, around 2^32,
  2^40) produces bit-identical output: the fault is accumulated state, not
  counter width.
- Root cause is **unconfirmed**. An earlier hypothesis, a per-period time
  accumulated in integer nanoseconds (0.333 ns lost per callback is about one
  period per 24 h), does **not** apply to the song producer: it recomputes
  `(frame - anchorFrame) * 1e9 / 48000` from the frame count each block
  (`:153`). `frameNs` and `EstimatedOutputTimeline::projectedNs` are likewise
  absolute or extended precision. A test that assumes cumulative truncation in
  that producer would model the wrong system. Evidence still to gather must
  separate expected resampling from repeated samples or unbounded headroom.
- Found while reading: the producer's `(frame - anchorFrame) * 1000000000ull`
  (`loopz_source_backend.cpp:153`) wraps 64 bits after about 106.7 h without a
  re-anchor. The late path recovers with one discontinuity. It does not explain
  a 24 h onset, but it is one more uptime-dependent event in this path.

## Decision drivers

- Remove the fault class, not only this instance: no audible state may grow with
  uptime, and no telemetry-invisible degradation.
- Follow ADR 0003: one clock domain where there is one device.
- Keep routing persistence, microphone analysis, meters, seek/loop, retained
  playback across UI restarts, and lyric presentation timestamps.
- Pi-class ARM64 CPU and memory budget; 256-frame period at 48 kHz.
- LoopZ stays cross-platform; the Box must not fork the player for Linux only.
- Reversible per release, testable without a day of waiting.

## Prior art

- **JACK** paces every client's process callback from the interface's hardware
  clock, once per cycle: one clock domain. A second device needs a buffer
  boundary and adaptive resampling.
- **PipeWire** has one driver node, normally the sound card, wake the graph;
  followers process in the same cycle. Adaptive resampling appears only where a
  follower sits on another driver, and its rate control steers on a smoothed
  buffer level.
- **zita-ajbridge** (Adriaensen, "Controlling adaptive resampling") closes the
  loop on measured latency, so delay converges to a defined value. Open-loop
  bridges are known to drift: `alsa_in`/`alsa_out` delay growing to about a
  second over weeks.
- **mpv** treats the audio device as the timing reference and states that the
  system clock is not the device clock.

## Options

1. **Pull in the device domain.** When the song's only enabled destination is
   one physical output, that output's callback renders the song and its
   routing directly. Both CPU-clock bridges leave the audible path: no song
   history read, no scene thread, no MonitorBus read, no servo. Histories and
   adaptive resampling remain for genuinely separate devices, with the read
   point supervised by measured headroom.
2. **Adopt PipeWire on the Box.** The interface is the driver, the song a
   follower node, extra devices and rate matching are PipeWire's.
3. **Keep the architecture.** Find and fix the bias, add an outer loop on
   measured headroom, and export it as telemetry.

| | 1. Pull in device domain | 2. PipeWire | 3. Fix + fill loop |
|---|---|---|---|
| Fixes | The class, for the default route: nothing left to accumulate | The class, by delegation | This instance once found; bounds the class |
| Song latency | Device queue only; removes ~1800-2800 frames | Quantum 256 plus daemon and node latency | Unchanged (~59 ms) |
| Pi CPU | Lower: two sinc passes and two wakeups per block removed | Higher: daemon, session manager, extra context switches | Slightly higher |
| Deadline risk | Song graph (stems, effects, convolution) must finish inside the ALSA period on the I/O thread | Same, inside a PipeWire data loop | Unchanged; a late producer is absorbed by the reserve |
| Mic analysis, meters | Unchanged: capture and taps stay in LoopZ | Rebuilt on PipeWire ports | Unchanged |
| Second output, software mic | Falls back to the history path (with option 3's loop) | Native | Unchanged |
| Lyric timestamps | Simpler and better: device presentation time, no route delay term | New mapping from PipeWire clock info | Unchanged |
| Seek/loop, retained playback | Player unchanged; backend swap only | Player unchanged; host lifecycle rewritten | Unchanged |
| Deployment | None | New daemon in the appliance image and service supervision; conflicts with exclusive ALSA ownership | None |
| Platform parity | Matches Desktop, which already pulls from the device | Linux only; LoopZ on macOS/Windows diverges | Same on all platforms |
| Effort | Medium to large: shared LoopZ runtime and source-interface work, Box backend, projection journals, tests | Large: routing, persistence and control rewritten | Small to medium, but open-ended until the bias is found |
| Reversibility | Route-level switch back to the history path | Poor | Trivial |

## Recommendation

Adopt **option 1, covering both bridges**, and apply **option 3's measured
headroom loop and telemetry** to every history path that remains. Reject
option 2. The implementer should build exactly this:

- **Seam.** The physical `Output::render` (`audio_runtime.cpp:580`) is the one
  synchronous clock seam. On the direct path it executes native song render ->
  device routing -> monitor routing inside that callback, for exactly the
  frames it will write. Moving only the song producer onto the callback is
  **not** this decision: it would leave the scene thread and the MonitorBus
  history, with its own rate estimate (`monitor.cpp:173-199`), in the path.
- **Shared LoopZ work, not a SingZ patch.** LoopZ gains a device-clocked native
  source interface (render callback instead of history read) and an output
  program that runs a song-bearing device's routing and monitor graph in the
  output callback. The existing `DirectMonitorProgram`
  (`third_party/loopz/native/core/direct_monitor.cpp`) is the precedent but is
  physical-input-only and not instantiated by the Linux runtime; extend or
  sibling it rather than reuse it as is. `SourceBackend` keeps the
  `AudioHostBackend` contract but is driven by that callback with
  `outputClockMaster` true and a presentation timestamp; its sleeping thread
  is not started on the direct path.
- **One serial render owner.** Song rendering is destructive (transport,
  cues, loop boundaries advance by callback frames), so exactly one owner
  renders it. The scene thread stops reading the song on the direct path. A
  change of clock owner drains the old owner before admitting the new one and
  is published with the output program as one prepared scene, including on
  failed open and recovery; it surfaces as a typed discontinuity.
- **Eligibility.** Direct when the song-bearing device has one enabled physical
  monitor and every other source mixed into it is absent or provably on that
  output's clock. Phase 1 is song-only; a same-interface input joins only once
  one duplex owner is proven, and the private capture owner used for analysis
  is preserved either way. Anything else (second output, virtual-device
  dependency, separate-interface microphone) uses the history path.
- **Fan-out and meters.** The callback also appends the rendered block to the
  song history stamped with presentation time, so secondary monitors and
  telemetry-only demand keep working through non-destructive reads. Source,
  device and monitor meters are published from the direct program.
- **Remaining history readers** export published-end minus read position
  (min, mean, max in frames) and steer on that smoothed value toward the
  budget; leaving the band is a counted fault and forces a re-anchor. "Fill"
  is read headroom in a timestamp-addressed history, not a FIFO level.
- **Option 2 is rejected**: it replaces the routing, persistence and control
  layer that works, adds a daemon beside an exclusive ALSA owner and splits
  LoopZ by platform, for a property option 1 gives inside the engine.
- The root-cause investigation continues: the defect also lives in desktop
  LoopZ, and the fallback path still depends on it.

## Consequences

- The default Box route has one clock domain, as ADR 0003 requires. Timestamp
  bias, servo state and resampler phase can no longer reach the song.
- Song latency falls by the monitor budget and scene lookback. The audible
  projection behind lyrics changes with it: the journals and primary-monitor
  mapping in `box_routing_owner.cpp:269-292`, `:530` feed
  `native_playback_session.cpp:8551`. On the direct path the song slice and the
  physical block share one callback, the route delay term is zero, and device
  queue latency must not be subtracted twice. Timing plan and journal
  interpretation change in the same commit; phone and TV sync are re-measured.
- The song graph now has a hard deadline of one device period on the ALSA
  worker (`SCHED_FIFO` 20). Today a late producer costs a history gap; after
  this change it costs an xrun. Worst-case render time on the reference board
  must be measured before the switch, and the period may need to grow.
- Song stop/change must still detach only the song: the output callback keeps
  running and renders silence when no song is prepared.
- Two song paths exist. The fallback path is exercised less and needs its own
  soak, or it will rot.

## What it unblocks

- Long-uptime appliance operation without a scheduled audio-host restart.
- Lower-latency software microphone monitoring later, since the song no longer
  sets a 59 ms floor.
- Headroom telemetry that turns "sounds wrong, counters clean" into an alarm.

## Open questions

- What state actually accumulates? Capturing the song history, the bus history
  and the device output on a degraded host separates the three stages. If the
  song history itself is degraded, the defect is upstream of routing and
  option 1 alone does not remove it.
- Does the full song graph, including convolution, fit a 256-frame period on
  the reference board with margin, or is 512 required?
- Should the scene renderer also be driven by the primary output, so that a
  software-mixed route is device-clocked too? Deferred until the direct path
  is proven.

## Validation plan

1. **Deterministic long run.** Drive the routing core with synthetic clocks for
   48 simulated hours at 256-frame periods, with injected biases: a constant
   sub-nanosecond timestamp bias per period, +/-100 ppm device drift, timestamp jitter, one-frame delay
   quantization. Assert bounded headroom and a null test against the source
   below a fixed residual at hours 0, 24 and 48. The same test must fail on the
   current history path once the bias site is known (negative control).
2. **Direct-path identity.** Output of the direct path equals the player render
   bit for bit, apart from gain and channel map, across seek, loop, pause, song
   change and route edit.
3. **Deadline.** Render-time histogram of the heaviest project on the reference
   ARM64 board; zero xruns over 24 h under UI and network load.
4. **Feature regression.** Microphone analysis, meters, retained playback across
   UI restart, routing persistence across host restart, lyric timing against a
   click track.
5. **Field soak.** At least 72 h continuous host uptime on a Box field unit,
   with a phone recording of the same song section at 0, 24, 48 and 72 h and
   the cepstral and band-energy comparison above. Pass: the 256/512/768/1024
   ratios stay within the fresh-host range and high-band energy within 1 dB.
   Repeat on a two-output route to cover the fallback path.

## References

- [ADR 0003: Clock domains and discontinuities](0003-clock-domains-and-discontinuities.md)
- [Box LoopZ integration contract](../specs/singz-box/loopz-integration.md)
- JACK: `jackd(1)`; Liquidsoap JACK notes, <https://www.liquidsoap.info/doc-dev/jack.html>
- PipeWire scheduling, <https://docs.pipewire.org/page_scheduling.html>; `spa/plugins/bluez5/rate-control.h`
- F. Adriaensen, "Controlling adaptive resampling", Linux Audio Conference 2012,
  <https://kokkinizita.linuxaudio.org/papers/>; zita-ajbridge
- jackaudio mailing list, 2016-04: `alsa_in`/`alsa_out` delay growth
- mpv manual, audio output drivers (`DOCS/man/ao.rst`)

## Open question / follow-up

This branch leaves fallback resampling control and latency unchanged and adds
per-reader headroom observation and fixed-budget band-exit faults only. Adaptive
bias cancellation needs a separate decision: per-reader integrated phase,
actual read-position provenance journals across both bridges and virtual DAGs,
and an acquisition target frozen within safe budget bounds. Merely changing the
resampler ratio cannot bound bias while each block restarts from its timestamp;
changing phase without composing that provenance would invalidate fallback
lyric projection. Field stage captures should inform that follow-up.
