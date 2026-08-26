# Phase 0B DSP performance baseline

Recorded: 2026-08-26<br>
Scope: contract/fake-host baseline, not production playback latency

Blank cells are evidence gaps. Simulator/emulator results are build and
correctness evidence only. No number below is inferred from an API setting.

## Fresh Phase 0B fake-host result

Host: Apple M2 Max, Darwin arm64. Release/NDEBUG AppleClang 21.0.0 build;
`zdsp_runtime`/prototype RT targets use `-fno-exceptions -fno-rtti`. The audio
interface is not opened by this benchmark.

Workload: prepared scalar gain→peak/RMS, planar float32 stereo, 48 kHz,
64-frame blocks, 10,000 warmups, then 2,000 batches × 256 calls. Timing many
calls per clock interval avoids presenting clock quantization as kernel time.
Each reported distribution sample is one batch elapsed time divided by 256;
the percentiles and maxima are normalized batch means, not individually timed
callback observations.
Input is deterministic nonzero noise; each graph call applies two linear
automation events and consumes output samples plus the returned-by-value meter
in a checksum, which was identical (`1738201.11`) in all three runs. The
runner-only probe sends valid zero-frame calls. Clock-pair cost and an empty
batched harness are reported separately.

| Normalized batch-mean metric across 3 consecutive runs | Empty harness | Runner-only | Gain→meter kernel |
| --- | ---: | ---: | ---: |
| p50 range | 0.8 ns/call | 14.2–15.0 ns/call | 225.6–233.9 ns/block |
| p95 range | not recorded | 14.8–19.2 ns/call | 273.3–299.3 ns/block |
| p99 range | 1.0–1.1 ns/call | 17.7–30.8 ns/call | 333.3–359.7 ns/block |
| maximum range | not used | 44.6–117.0 ns/call | 455.2–477.1 ns/block |
| p99 / 1.333 ms callback deadline | — | 0.001328–0.002310% | 0.025000–0.026978% |
| deadline-miss batches | — | 0 / 2,000 each run | 0 / 2,000 each run |
| allocations during guarded contract test | — | — | 0 / 1,000 variable-block calls |

The deadline-miss count compares each whole batch with 256 callback deadlines;
it cannot prove that no individual invocation exceeded a deadline. The
consecutive clock-pair p50/p99 values were 0/42 ns, exposing the clock's
quantization at this scale. These are isolated prototype kernel measurements,
not device callback, production graph runner/compiler, miniaudio/JUCE,
API/device latency or end-to-end latency evidence. Maximum values are maximum
normalized batch means and retain scheduler effects visible at batch scale.

## Device evidence inventory

| Platform/hardware | Evidence source and freshness | Rate/block | Callback→sink CPU | Xruns/overruns | API/device latency | Measured input→output |
| --- | --- | --- | --- | --- | --- | --- |
| Dell Windows laptop, MSVC/WASAPI | Phase 0A physical run, carried forward from the implementation session; not rerun in Phase 0B | Capture produced 603 delivered samples; negotiated rate/block were not preserved in the available transcript | p50 0.0207 ms, p95 0.0351 ms, maximum 0.1739 ms; p99 not preserved | zero transport overruns; device xruns not separately recorded | not recorded | not measured |
| Mac + Zen Quadro, microphone channel 3 | No numeric log is present in the worktree and the device was not freshly rerun | not recorded | not recorded | not recorded | not recorded | not measured |
| iPhone/iPad hardware | No fresh physical Phase 0B measurement; simulator compilation is build evidence only | not measured | not measured | not measured | not measured | not measured |
| Android hardware | No fresh physical Phase 0B measurement; ABI builds/emulator tests are build evidence only | not measured | not measured | not measured | not measured | not measured |

## Required next measurements

- Run the same timestamped fake-host probe inside each real device callback and
  record actual rate, callback-size histogram, device/buffer latency,
  p50/p95/p99/max CPU, xruns and thermal/power mode.
- Perform wired loopback correlation separately from API-reported latency on
  Mac/Zen, Dell/WASAPI shared and exclusive, a real iPhone and a real Android.
- Repeat route snapshots for Bluetooth and available automotive routes, marked
  presentation-only and high variance.
- Compare the SingZ kernel with miniaudio only in an isolated benchmark target.
  Compare JUCE only after its commercial-license decision. Neither dependency
  may enter `zdsp_api` or the shipping runtime for the comparison.
- ASIO stays disabled until its separate licensing/backend gate is resolved.

The benchmark emits one JSON object so controlled-hardware runs can be stored
without scraping prose. Future updates include raw JSON, commit, compiler,
power state and exact device identifiers.
