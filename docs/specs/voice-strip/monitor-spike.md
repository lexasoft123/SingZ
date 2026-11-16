# Monitoring measurement spike (ADR 0017 WP0b)

This optional standalone CLI prototypes the split-owner path without Electron or
changes to the shared service, take transport, monitor, or zCore. It is a
measurement tool, not production monitoring or a hardware qualification receipt.
Production monitoring now uses the common service/history client (ADR 0017 WP6);
this CLI’s explicit device selection is independent of the app, whose only
output selection lives in Settings. The legacy app duplex host is removed.
Read [ADR 0017](../../adr/0017-monitoring-through-the-common-mixer.md), especially
G1–G3. Coordinate hardware use and keep device UIDs, console receipts and any
external recordings in the private development handbook's evidence storage.

## Build and portable checks

From the repository root on macOS, with CMake, Python 3 and the command-line C++
tools installed and the pinned zCore submodule present:

```sh
cmake --preset monitor-spike
cmake --build --preset monitor-spike
ctest --preset monitor-spike --no-tests=error
cmake --preset monitor-spike-asan
cmake --build --preset monitor-spike-asan
ctest --preset monitor-spike-asan --no-tests=error
cmake --preset monitor-spike-tsan
cmake --build --preset monitor-spike-tsan
ctest --preset monitor-spike-tsan --no-tests=error
```

Each build has its own directory and at most four compile edges. These targets
build from local zCore sources and need no app, npm, Electron, analyzer or audio
hardware. Existing native graph/source policies still run for their dependencies.
The portable suite covers queue floors, ten minutes of fake-clock observations
at ±0.3%, 48→44.1 kHz history reads with both drift signs, split reads above 256
frames, counted missing-history silence, simultaneous producer/reader activity,
direct output clamping/muting, allocation-free reads, waveform integer/fractional
delay, independently drifting 48→44.1 kHz waveform timestamps, muted and silent
negative controls, and incomplete-run verdicts. Six
compiled mutants of `core.cpp` deliberately remove the floor, clock tracking,
missing counter, unknown-measurement guard, rejected-interval diagnostic flag
and exact synthetic timestamp grid, running the unchanged assertions.
An exact-stderr wrapper requires exit 1 and the intended assertion; a crash,
sanitizer diagnostic or unrelated failure cannot pass a negative control. The
callback source policy has its own
allocation negative control. Sanitizer failures are failures, never hardware
results. The fake-clock ten-minute observation is not ten minutes of hardware. Diagnostics
also have JSON/CSV parser round-trips, forced buffer overflow, arrival-jitter,
allocation-trapped capture/read events, concurrent producer/renderer diagnostics
and the one-sample clock-step reproduction described below.

## Select devices explicitly

```sh
build/native/monitor-spike/tools/monitor-spike/monitor_spike_harness --list-devices
build/native/monitor-spike/tools/monitor-spike/monitor_spike_harness --help
```

Neither command starts a stream on macOS. No arguments prints help. A run needs
`--run`, exact input and output names or UIDs, `--allow-buffer-change`, and exactly
one of `--mute-output` or `--audible`. Ambiguous names fail. Channels are
**zero-based**, including internal return channels; a documented input 9 normally
means `--loopback-channel 8`, but inspect the device's actual map first.

Set these shell variables to the exact UIDs printed above; never substitute the
system default. For same-device tests, set both to the same UID. For cross-device
tests, select separate physical devices with independent clocks; two virtual
endpoints or an aggregate do not establish independent clocks.

```sh
export MONITOR_INPUT_UID='replace with selected input UID'
export MONITOR_OUTPUT_UID='replace with selected output UID'
```

The period opt-in permits zCore to change a shared device property. Close other
clients in the reserved window and record the original period. The existing
zCore lease attempts restoration when the last owner stops and skips restoration
after an external change. After normal completion, interruption or terminal
closure, run `monitor_spike_harness --list-devices` again using the full path
above, compare each affected device's `period=` with the recorded original, and
inspect the printed buffer warnings. A signal handler requests cleanup; period
restoration is established by read-back, never by the signal receipt alone.
This harness does not set persistent device rates. Configure rates through
the operator's device controls before a run; `--input-rate` asserts the negotiated
capture rate and `--output-rate` requests and then asserts the output rate.

## Timestamp-only runs

Start with a muted short run. This opens capture even in virtual-source mode,
then generates a quiet chirp train in the backend's capture callback instead of
using microphone PCM. The output host stays **output-only** in history mode.

```sh
build/native/monitor-spike/tools/monitor-spike/monitor_spike_harness --run \
  --input "${MONITOR_INPUT_UID:?set input UID}" --output "${MONITOR_OUTPUT_UID:?set output UID}" \
  --allow-buffer-change --mute-output --virtual-source --mode history \
  --periods 32,64,128 --queue-frames 0 --seconds 60
```

History uses the zCore `AudioInputBackend` real-time push, avoiding the delivery
queue and the not-yet-implemented WP1 capture tap. It appends original first-sample
hardware timestamps to zCore `AudioHistory`; it does not invent an authoritative
source frame counter. The output reads at presentation time minus an explicit
queue, through zCore's prepared resampler, split into chunks of at most 256 frames.
LoopZ's local output-rate estimator follows overlapping 25–50 ms observations,
within ±0.5%; each callback keeps its own timestamp anchor. The floor in **capture
rate frames** is `max(queue-frames, ceil(2 * period * inputRate / outputRate) + quantum)`.
Defaults are queue 1024 and quantum 256. `--queue-frames 0` selects the floor;
`--quantum 0` is an explicitly experimental smaller floor. Effective values are
printed per cell. History capacity is 32768 frames, with queue capped at half.

The history timestamp estimate is the presentation-to-source-read timestamp
distance on successfully covered blocks; it equals the explicit queue and is
**not a measured physical round trip**. Direct mode reports the provider's input block timestamp to output presentation
timestamp. macOS duplex metadata uses the AUHAL render timestamp for both, so
that estimate can be zero and cannot establish physical direct latency. Neither estimate passes G2.
Unknown/estimated capture and output timestamp provenance is printed; a waveform
with non-hardware timestamps cannot pass a latency gate. A missing
history block is counted silence and does not terminate the output/bed.

## Waveform loopback and direct comparison

Use a verified internal return or a controlled cable return to an **input channel
on the output device**. Keep hardware direct monitoring and other routes muted,
with headphones/quiet isolated returns. Gain defaults to 0.05, accepts at most
0.5, and the complete voice/bed output is clamped to ±0.5. `--audible` is explicit
because native output bypasses the application's mute controls. No feedback
prevention is inferred from a device name.

For one same-device cell, after setting `MONITOR_RETURN_CHANNEL` to its zero-based
return channel:

```sh
export MONITOR_RETURN_CHANNEL=8 # example only: verify the physical channel map
build/native/monitor-spike/tools/monitor-spike/monitor_spike_harness --run \
  --input "${MONITOR_INPUT_UID:?set input UID}" --output "${MONITOR_OUTPUT_UID:?set output UID}" \
  --allow-buffer-change --audible --gain 0.05 --virtual-source \
  --loopback-channel "${MONITOR_RETURN_CHANNEL:?set return channel}" \
  --mode both --periods 32,64,128 --queue-frames 0 --bed --seconds 600
```

`both` runs history and direct sequentially for each period. Direct opens one
same-device duplex zCore `AudioHost`, using `block.input`, or the generated test
signal at that boundary with `--virtual-source`. Cross-device direct is refused.
Loopback is a separate zCore capture owner on device B, preserving the
history output host's output-only contract. All streams stop before analysis.

Each cell adds the configured warmup (default 3 s), then 12 s calibration: 4 s
muted control followed by two 4 s signal segments. The synthetic bed starts only
after calibration, so it does not contaminate waveform correlation. Six
chirp-bearing 0.5 s windows (three per segment) must correlate at least 0.9999,
with delay spread no greater than one return sample. Analysis reconstructs closed callback sample intervals between their hardware
anchors, aligns those timestamps, searches up to `--max-lag-ms 100`, then refines fractional lag. A muted
control needs RMS below `--control-rms-limit 0.00001` and correlation below 0.2.
Analog returns can use an explicitly recorded higher RMS limit and lower
`--correlation` threshold; defaults match the strict internal-return method.
Silent, leaking, noisy, incomplete, unsupported or uncorrelated captures remain
`NOT MEASURED`. PCM stays in bounded preallocated memory and is never written.

Virtual waveform numbers **are not comparable across history and direct**.
HISTORY-virtual stamps its generated chirp at the capture backend's hardware
first-sample time, so its queue includes input-side buffering. DIRECT-virtual
stamps at `block.inputSampleHostTimeNs`, the AUHAL render timestamp: it excludes
about one input period plus input latency and therefore looks faster by that
amount. Every virtual cell prints this bias and its direction. DIRECT-virtual's
waveform path comparison gate is always `NOT MEASURED`; its raw waveform number
remains a render-boundary measurement only. HISTORY-virtual can print its own
capture-origin path gate, but this is never evidence for a cross-mode comparison
or physical G2. Both virtual modes exclude the physical microphone converter.

To measure the captured-input→return scope of the LoopZ reference,
omit `--virtual-source` and supply an external chirp train to the selected physical
input. Its captured reference must contain six suitable signal windows; the CLI
does not play a test signal into that input. Correlation uses the actual captured
reference; weak or unsuitable live audio cannot qualify. Physical direct-loopback
runs open an additional input reference capture, because the duplex render
metadata cannot timestamp the older physical input samples independently. This
reference is measurement instrumentation; the audible direct route still reads
`block.input` through exactly one duplex host. Neither mode measures
loudspeaker/air paths outside the selected return. Cross-device waveform
alignment also depends on the capture timestamp quality on both devices.

## Matrix and interpretation

Repeat the history command with two independently clocked physical devices:
once at equal nominal rates and once at different nominal rates, for example
48 kHz capture and 44.1 kHz output using `--input-rate 48000 --output-rate 44100`
after configuring those devices. Sweep 32/64/128 and queue values down to the
printed floor. Use `--mode history` for cross-device cells. A route without a
return channel can run timestamp-only; record waveform latency as unknown.

The per-cell table prints waveform and timestamp estimates, counted missing
frames, xruns, G1, G2 and G3. Additional lines include anchor jumps and inferred
capture loss, history discontinuities, render failures, deadline misses, slice
drops, achieved callback periods, queue occupancy mean/SD/min/max, callback
arrival jitter and callback CPU mean/SD/min/max. CPU uses macOS per-thread Mach
user+system time around the full renderer (resampler, mix and metering included).
Its microsecond resolution and measurement syscall overhead are visible limits;
it is not whole-process CPU or the cost of the full song DSP graph.

G1 defaults to 600 s, zero missing frames, zero timestamp/continuity/host errors,
a playing unmuted synthetic bed, complete coverage and exactly the requested
period. Short runs, muted runs, no bed, or incomplete measurements cannot pass.
`--required-seconds`, `--allowed-missing` and `--max-latency-ms` make alternate
criteria explicit. G2 cells require a same-device captured-source waveform result ≤10 ms at 32 and
64 frames; retain both periods and G1 before making the ADR decision.
The virtual-source path's separate comparison is never physical G2. G3 remains
`NOT MEASURED` per individual cell: the owner must combine the independent-clock
equal/different-rate G1 receipts and set the refusal ceiling. Any measured G1
failure is printed as a failed G3 cell for a cross-device route.

Exit 0 means the requested cells completed without a measured failure, **not**
that all gates passed; inspect `NOT MEASURED`. Exit 1 means a measured gate failed;
exit 2 means invalid configuration, open/runtime failure or incomplete coverage.
SIGINT/SIGTERM/SIGHUP request the same control-loop teardown, joining all
task-owned streams. Report the exact source revision,
requested/achieved rates and periods, input/output transport, topology, thresholds,
mode, queue, gain, warmup, run time, controls, counters and compiler/build receipt
in private evidence. No hardware has been qualified by the portable tests.

Known limits: macOS hardware only in this spike; portable fake-clock tests can run
on other supported build hosts. No production service integration, real song
pipeline, recording/take proof, permission-prompt UI, hotplug recovery or Bluetooth
qualification is claimed. The mono backend provides timestamps but no hardware
sample position: source losses are inferred from timestamp residuals beyond two
frames or the ±0.5% drift tolerance, and losses hidden by a driver remain unknown.
Different UIDs alone never prove independent clocks. Run production and Windows
acceptance in later work packages and retain the owner's gate decision separately.

## Discriminating the periodic history hole

The supplied hardware runs (harness `f9f164f`, not rerun here) lost
198/390/774 frames in 60 s at 32/64/128 frames: exactly six times
33/65/129. The 600 s same-device duplex run lost none; a 1024-frame history
queue did not remove the hole. This strongly suggests one rejected *clock
interval*, rather than an inherently lossy history or an output underrun.
It does not establish which component originates the timestamp step.
The source review below uses zCore pin `bd189250577186a69f01ff2eb9c59a69d30aa64b`.

| Candidate | Code evidence and discriminating signature |
| --- | --- |
| Capture host-time projection steps outside the local slope bound (leading hypothesis) | `third_party/zcore/zcore/src/routing/sample_clock.cpp:26-49` admits only ±0.5% without a proven continuous sample counter. At 48 kHz, one sample of timestamp phase error exceeds this bound at **all three periods**. `:174-177, 232-237` rejects the whole closed interval; `audio_history.cpp:419-424` counts each unmappable output frame as missing. This need not increment the history generation/discontinuity counter or the harness's more tolerant two-frame anchor-jump counter. |
| Missing hardware sample-position metadata prevents the existing correction | `third_party/zcore/zcore/platform/macos/audio_input_macos.cpp:651-664` forwards the AUHAL `mHostTime` but not `mSampleTime`; `tools/monitor-spike/core.cpp:144` calls `append` without authoritative source frames. `audio_history.cpp:209-220` therefore passes `contiguous=false`. The special three-sample local-slope allowance and bounded effective-anchor correction in `sample_clock.cpp:43-49, 94-113` are unavailable. A callback-count-derived counter would hide real capture loss and is not a fix. |
| Output estimator changes or resets | `tools/monitor-spike/core.cpp:58`, `OutputClock::observe`, uses 25–50 ms overlapping observations, ±0.5% acceptance and a 2 ms reset bound. `core.cpp:169`, `Renderer::render`, starts each block at its hardware presentation timestamp minus queue; it does not integrate estimated rate across ten seconds. Rate changes can force fractional FIR reads and expose marginal support, but there is no ten-second correction timer or explicit block skip. Correlate output rate changes with `support_missing` and queue minima. |
| History re-anchor / local correction | `audio_history.cpp:144-161` resets the generation for >2 ms gaps, nonmonotonic time, format changes or a discontinuous authoritative counter, advancing the internal cursor by capacity. It invalidates the old generation rather than intentionally dropping/repeating one block. Half-second rate observations at `:169-191` only update the fallback estimate. `sample_clock.cpp:94-113` adjusts effective timestamp phase, not a sample read cursor, and requires proven continuity. A `history_discontinuities` increment distinguishes reset from local interval rejection. |
| Too little *available* queue, especially cross-device | `audio_resampler.cpp:135-138, 193-195, 229-231` needs past/future FIR support; the header `audio_history.h:44-48` describes the symmetric radius. The floor does not include measured capture availability latency. The requested delay minus capture buffering/output presentation lead can leave much less occupancy (the supplied mean was about 3 ms for 8 ms requested). `support_missing` plus `unpublished` and low/negative occupancy supports this explanation for the 31–59% cross-device loss. A bigger queue helps this case, not an invalid historical clock interval. |
| USB/CoreAudio timestamp quantization or periodic device/system event | The capture backend converts supplied host ticks to integer ns at `audio_input_macos.cpp:654-656`; it has no ten-second timer and does not query timestamp resolution. `audio_host_macos.cpp:983-1022` independently consumes output host/sample timestamps. One-ns conversion alone is explicitly tolerated by `sample_clock.cpp:31-34`; a one-sample phase step is much larger. A repeating input delta anomaly with steady synthetic controls implicates the capture timestamp path, but cannot by itself distinguish driver clock projection from actual lost samples or a system event. `input_buffer_warnings=4` is the `AudioBufferWarningReadFailed` bit (`third_party/zcore/zcore/include/zcore/device/audio_buffer.h:11`), not a count of four underruns or proof of a period change. Obtain hardware sample-position metadata before declaring the samples contiguous. |

A portable test now injects **one persistent one-sample timestamp phase step**
into the actual history/renderer with a 1024-frame queue and no sample counter.
It produces exactly **period + 1 clock-missing frames** at 32/64/128, with zero
history discontinuities and zero post-startup resampling-support misses.
The same output callback's synthetic direct-copy control loses no samples.
This reproduces the supplied hole's size, not its wall-clock recurrence or the
Zen's actual timestamp behavior. No zCore or production behavior is changed.

### Mac commands

Build the release preset above, reserve the device window, select the explicit
UIDs and record the original periods as described earlier. The commands below
are diagnostic, muted continuity probes, so G1 remains `NOT MEASURED` even when
there are zero errors; they cannot qualify G2/G3. Set `MONITOR_DUMP_DIR` to an
existing **private evidence directory**. Every cell includes the 3 s warmup in
the dump; the measured interval begins at approximately `since_start_s=3`.
Use the same output route and period for all controls, and verify restoration
after **each command**, including failed runs. No command changes device rates.

```sh
# 1. Exact-clock synthetic producer -> same history/resampler -> output-only host.
# No physical capture is opened, and --input is unnecessary.
build/native/monitor-spike/tools/monitor-spike/monitor_spike_harness --run \
  --synthetic-source --output "${MONITOR_OUTPUT_UID:?set output UID}" \
  --mode history --allow-buffer-change --mute-output --bed \
  --input-rate 48000 --output-rate 48000 --periods 32,64,128 \
  --queue-frames 1024 --seconds 600 \
  --dump-prefix "${MONITOR_DUMP_DIR:?set private evidence directory}/synthetic" --dump-format json

# 2. Real capture callbacks/timestamps, generated PCM -> history -> output-only host.
# --virtual-source replaces PCM only; hardware capture and its timestamps remain.
build/native/monitor-spike/tools/monitor-spike/monitor_spike_harness --run \
  --input "${MONITOR_INPUT_UID:?set input UID}" --output "${MONITOR_OUTPUT_UID:?set output UID}" \
  --virtual-source --mode history --allow-buffer-change --mute-output --bed \
  --input-rate 48000 --output-rate 48000 --periods 32,64,128 \
  --queue-frames 1024 --seconds 600 \
  --dump-prefix "${MONITOR_DUMP_DIR:?set private evidence directory}/capture" --dump-format json

# 3a. Exact synthetic sample block -> direct copy -> output-only host, no history/capture.
build/native/monitor-spike/tools/monitor-spike/monitor_spike_harness --run \
  --synthetic-source --output "${MONITOR_OUTPUT_UID:?set output UID}" \
  --mode direct --allow-buffer-change --mute-output --bed \
  --output-rate 48000 --periods 32,64,128 --seconds 600 \
  --dump-prefix "${MONITOR_DUMP_DIR:?set private evidence directory}/copy" --dump-format json

# 3b. Existing hardware duplex direct baseline; input/output must have the same UID.
build/native/monitor-spike/tools/monitor-spike/monitor_spike_harness --run \
  --input "${MONITOR_OUTPUT_UID:?set same-device UID}" --output "${MONITOR_OUTPUT_UID:?set same-device UID}" \
  --virtual-source --mode direct --allow-buffer-change --mute-output --bed \
  --output-rate 48000 --periods 32,64,128 --seconds 600 \
  --dump-prefix "${MONITOR_DUMP_DIR:?set private evidence directory}/duplex" --dump-format json
```

For each command, read back `--list-devices` using the full harness path and
compare the period with the original before proceeding. After the 1024-frame
controls, repeat with `--queue-frames 0` to test the floor. For cross-rate
history controls, set the actual output device to 44.1 kHz and use
`--input-rate 48000 --output-rate 44100`; synthetic direct copy always runs at
the output rate and does not test conversion. A `--mode both --synthetic-source`
run also executes the two synthetic controls sequentially.

The synthetic history producer runs independently on a control-owned thread.
Its first-sample times are `origin + floor(frame * 1e9 / sourceRate)`, and each
block is published after its nominal end. Wake-up lateness is **not** inserted
into the source timestamps; overdue blocks are published on that exact grid.
Scheduling stalls can therefore still cause `unpublished` support failures.
The direct-copy control generates the same chirp function into a prepared
sample block at the output rate and copies it in the output-only callback;
it removes the producer thread, history, mapper and resampler. It bounds the
output host/callback contribution, not independent producer scheduling or
physical input latency. Neither synthetic mode claims hardware capture times.

### Dump schema and reading events

`--dump-prefix PATH` enables diagnostics; without it the existing hardware
path retains its clock and buffering behavior. It allocates separate fixed
producer/renderer row arrays before start and enables zCore's existing atomic
read-reason counters. No callback does file IO, formatting, locking or allocation.
Rows are written only **after every stream has stopped and joined**. Each cell
writes `PATH.[synthetic-]history|direct.PERIOD.capture|output.json` (or `.csv`).
JSON schema 1 includes `origin_ns`, `dropped`, `rows` and `delta_histogram`;
CSV adds separate `.csv.histogram.csv` files. Dumps contain numeric timing and
counters, never PCM. Keep them with their console configuration/build receipt.

Every exceptional interval/read is retained, plus an ordinary rate/queue row
at most every 100 ms. Capture histograms observe **every callback interval**,
including warmup, independently of row sampling. Histogram bins 0–255 are
`delta / expected_previous_period` in intervals `[i/64,(i+1)/64)`; 256 means
at least four periods and 257 means nonmonotonic host time. These are normalized
host-delta histograms, not callback-arrival histograms. Multiply by the previous
period duration to recover ns for fixed-period cells. Raw exceptional deltas
retain integer-ns resolution in the rows.

Flags are a bitmask: `1` ordinary sample, `2` harness anchor jump,
`4` interval outside zCore's unverified-clock admission bound, `8` history
reset, `16` effective capture anchor corrected, `32` missing history read,
`64` output-host discontinuity, `128` rejected append, `256` callback-arrival
interval differs from nominal by more than 2 ms (or moves backwards). Every row includes bit 1;
select events with `flags != 1`. Output flag 4 describes the output interval
only; output samples use the estimator, so it is not itself a source failure.
Capture `frame` is the received callback-frame total, **not** a hardware counter.
`callback_host_ns` and `callback_delta_ns` retain actual callback arrival time
and the preceding arrival interval; compare them with first-sample host deltas
to distinguish delivery stalls from timestamp phase changes. `timestamp_quality`
is 0 unknown, 1 hardware or synthetic exact grid, 2 callback estimate; the
console source label and filename distinguish synthetic from hardware.

`delta_ns - expected_ns` is the input first-sample host-time residual against
the preceding block's nominal duration. Capture `expected_frames/got_frames`
are preceding/current delivered block sizes (got is zero on rejected append);
output fields are requested/available output frames. Capture `estimated_hz`
is the history's overlapping 0.5–1 s estimate; output is the actual 25–50 ms
estimate used by the renderer. Compare with `nominal_hz` as
`1e6 * (estimated_hz / nominal_hz - 1)` ppm. The instantaneous capture interval
rate is `expected_frames * 1e9 / delta_ns` and can fail admission while the
longer estimate looks healthy.

Capture `correction_ns` is **observed effective history anchor minus raw input
anchor**; output `correction_ns` is estimated minus nominal block duration used
for the within-block sample grid. The private `localClockCorrection` resampler
flag is not exported; with this counter-free capture append it cannot activate.
`queue_before_ms/queue_after_ms` are published source end minus output target,
before/after append or read. Capture snapshots use the most recently published
output target; zero before the first target means unavailable. They are atomic
observations, not a synchronized transaction, and the reader does not consume
or pop history. A change during read can simply be a concurrent publication.

`clock_missing` and `support_missing` count output frames by zCore reason for
that read. `unpublished/expired/racing` count failed **source sample lookups**,
which may exceed missing output frames. Other unavailable/offline/generation
failures still have `got_frames < expected_frames` and bit 32. Use the full
`history_discontinuities` count to distinguish a reset. The default capacity is
262144 rows **per stream**; `--diagnostic-capacity N` changes it (maximum two
million). Any overflow prints `dropped > 0` and exits 2 as incomplete evidence.
Rate snapshots can omit short-lived changes between samples; all admission
failures and missing reads remain event rows unless this explicit overflow occurs.

For example, inspect only the clock/missing events (the rejected interval ends
at the flagged capture anchor, so a queued output event occurs later):

```sh
python3 - "${MONITOR_DUMP_DIR:?set private evidence directory}/capture.history.64.capture.json" <<'PY'
import json, sys
x = json.load(open(sys.argv[1]))
assert x['dropped'] == 0
for r in x['rows']:
    if r['flags'] != 1:
        print(r['since_start_s'], r['flags'], r['delta_ns'] - r['expected_ns'],
              r['expected_frames'] - r['got_frames'], r['clock_missing'],
              r['support_missing'], r['queue_before_ms'], r['correction_ns'])
PY
```

If only hardware-history has periodic rejected capture intervals followed by
`clock_missing`, retain same-device duplex direct and extend zCore's capture
metadata with the real, validated AUHAL sample counter before changing clock
policy. Then test the existing bounded correction with genuine continuity,
without smoothing away actual losses or changing take timestamps. If synthetic
history also fails with regular source anchors, use read reasons to separate
producer scheduling/queue support from output timestamp/rate behavior; only a
rate-correlated failure justifies investigating a PLL instead of step estimates.
If losses are `support_missing + unpublished`, size the initial available
occupancy using capture latency, presentation lead and FIR support, then rerun
G1. If hardware timestamps cannot support stable low-latency history, the
design must keep same-device duplex direct and use a separately qualified,
more delayed cross-device history profile; the supplied data do not prove
that all histories or all USB capture devices inherently lose audio.
