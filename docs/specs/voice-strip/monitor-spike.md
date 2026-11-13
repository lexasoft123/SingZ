# Monitoring measurement spike (ADR 0017 WP0b)

This optional standalone CLI prototypes the split-owner path without Electron or
changes to the shared service, take transport, monitor, or zCore. It is a
measurement tool, not production monitoring or a hardware qualification receipt.
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
delay, independently drifting 48→44.1 kHz waveform timestamps, muted and silent negative controls, and incomplete-run verdicts. Four
expected-failure tests deliberately remove the floor, clock tracking, missing
counter and unknown-measurement guard. The callback source policy has its own
allocation negative control. Sanitizer failures are failures, never hardware
results. The fake-clock ten-minute observation is not ten minutes of hardware.

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
after an external change; inspect printed buffer warnings and read the period
back. This harness does not set persistent device rates. Configure rates through
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

Virtual waveform latency measures capture-callback generation → history/direct
render → output/return capture. It excludes the physical microphone input path,
and prints a separate path comparison gate while physical G2 remains
`NOT MEASURED`. To measure the captured-input→return scope of the LoopZ reference,
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
SIGINT/SIGTERM joins all task-owned streams. Report the exact source revision,
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
