# Windows low-latency audio input

SingZ's native audio core keeps the public `AudioInput` lifecycle, SPSC ring,
float blocks, timestamps, and analyzers independent of the host API. Windows
uses an event-driven `WasapiAudioInputBackend`; macOS uses AUHAL in its own
translation unit. Both produce one selected mono lane as native-rate float32.

## WASAPI provider

WASAPI shared mode is the default because it coexists with other applications.
The backend asks `IAudioClient3` for the endpoint's minimum supported shared
period and falls back to ordinary event-driven shared capture when a driver
does not support the low-latency initialization. The capture thread is tagged
`Pro Audio` with MMCSS. It initializes no render endpoint.

The Windows audio engine's mix format is normally float32. Drivers that expose
PCM16, packed PCM24, or PCM32 are converted once at the capture boundary into
the same float32 contract. Conversion, deinterleaving, and ring delivery use
preallocated buffers and allocate or lock nothing in steady state.

Endpoint IDs are the opaque stable IDs returned by `IMMDevice::GetId`, prefixed
with `wasapi:` so another provider can describe the same physical interface
without an identity collision. WASAPI does not reliably publish per-lane
hardware names, so lanes fall back to `Channel 1`, `Channel 2`, and so on.

## Timestamp contract

For each packet, `callbackHostTimeNs` is sampled from QPC before conversion or
ring delivery. A nonzero WASAPI QPC position without
`AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR` is marked `Hardware`. A zero position or
timestamp-error packet instead gets a bounded first-sample estimate of callback
entry minus the packet duration and is marked `CallbackEstimate`; zero/error
timestamps are never presented as hardware. The shared analysis adapter resets
on either provenance transition so an analysis window cannot combine the two
timelines. Capture timestamps remain raw and receive no output-latency
compensation. AUHAL follows the same rule on macOS: only a nonzero
`kAudioTimeStampHostTimeValid` value is hardware, while a missing value uses the
callback-entry estimate.

## ASIO provider gate

ASIO is a separate future `AsioAudioInputBackend`, selected by an `asio:` UID.
It will not be implemented inside or as a mode of the WASAPI class. The build
switch is off by default and the Steinberg SDK is never stored in this repo:

```powershell
cmake -S mobile/native/core -B build `
  -DSINGZ_ENABLE_ASIO=ON `
  -DSINGZ_ASIO_SDK_DIR=C:\path\to\asio
```

Configuration first checks for `common/asio.h`, then intentionally fails with
the pending legal/implementation gate. This prevents an `ASIO=ON` build from
silently shipping only WASAPI. Shipping builds must remain at
`SINGZ_ENABLE_ASIO=OFF` until SingZ has a signed proprietary SDK agreement (or
the complete application is intentionally distributed under GPLv3) and the
separate provider implementation has passed its driver lifecycle tests.

## Hardware verification

On a Windows machine, build `singz-analyze`, enumerate endpoints, then capture
a selected zero-based lane for a bounded run:

```powershell
build\Release\singz-analyze.exe input-devices
build\Release\singz-analyze.exe live-input `
  --device-uid "wasapi:<endpoint-id>" --channel 0 `
  --latency --duration 12
```

The run must emit `ready`, live analysis frames, a latency record, and `ended`.
Acceptance is at least 500 callbacks, callback-to-core p95 no greater than
3 ms, no unexpected discontinuities, and zero ring overruns under normal load.
