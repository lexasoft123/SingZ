# Windows native audio

Phase 3B adds a standalone WASAPI provider behind `zcore::AudioHost`. It is a
headless conformance path only: Electron playback still belongs to Web Audio,
mobile playback still belongs to RNAudioAPI, and the hardware CLI always
renders silence. No product screen or playback engine selects this provider.

## Endpoint and format contract

`AudioHost::enumerate()` runs on a short-lived STA and returns active capture
and render endpoints separately. Their Windows endpoint IDs are opaque UIDs;
friendly names are display text only. Defaults use the `eConsole` role.
Inventory reports the current shared-engine profile from `GetMixFormat` and
the shared period range from `IAudioClient3` when available. It does not call
that profile a hardware maximum and does not infer exclusive capabilities.

Opening requires explicit capture and render endpoint UIDs whose
`PKEY_Device_ContainerId` values exist and match. It also requires equal
negotiated rates. A selected channel is validated against the exact initialized
endpoint format and is never clamped or remapped.

Shared event-driven mode is the default. The provider requests the smallest
legal `IAudioClient3` engine period, or an exact `--buffer` period when given.
If the low-period API is unavailable, default-period shared initialization is
allowed only when no exact period was requested. That fallback always uses a
fresh client and repeats activation, checked properties, `GetMixFormat`, exact
profile validation, initialization, and default-period query; no failed
Client3 period leaks into diagnostics. `--exclusive` is a separate
mode with no shared fallback. This checkpoint accepts only exact float32
exclusive formats. The provider probes exact channel-count candidates from the
highest selected lane through the public channel bound and uses only an exact
`IsFormatSupported` success; it never synthesizes exclusive channels from the
shared mix profile. Devices that expose only integer exclusive PCM fail with a
truthful message because complete PCM16/24/24-in-32/32 conversion is deferred.
On the Dell Realtek/APO stack, an immediate reopen can transiently return
`REGDB_E_CLASSNOTREG` while probing the just-released shared engine. Endpoint
preparation retries that identical exact profile at most four times, with a
10-ms stop-event wait between attempts. It never changes format, period, or
access mode, and any other result fails immediately.

## Ownership and real-time topology

Capture and render share one long-lived STA owner/event thread. That owner
activates and initializes both `IAudioClient` instances, acquires both service
sets, waits on both endpoint events, stops render then capture, releases all
services before clients and devices, unregisters notifications, closes endpoint
events last, and balances COM. It joins MMCSS `Pro Audio` at normal priority.
Normal stop, failed start, and post-worker open failure use the same teardown
sequence: publish stop, join the owner, quiesce the graph callback gate, then
close control and endpoint events. Open failure chooses its public error and
state from one coherent route snapshot after that join, so loss during teardown
cannot be reported as a non-device error.

The capture action drains every shared packet (or one whole exclusive event
buffer), converts selected interleaved float lanes into a preallocated planar
SPSC FIFO, and publishes device-frame/QPC metadata spans. Silent packets are
synthesized as zero. Data discontinuity and timestamp-error flags are kept.

The render action is the only graph caller and therefore the master clock. The
owner wait set gives stop, render, then capture handle priority so a selected
render wake is timestamped immediately, before polling or converting a
co-signaled capture packet. Shared mode also snapshots padding and the fixed
frames-to-write at that point; render never re-queries padding for the same
request. Capture still drains before the graph/render action when both are
ready. In shared mode every render-only wake also performs a nonblocking
`GetNextPacketSize` capture drain before the graph call. This removes endpoint
event-phase inversions without adding a second safety period. The immutable
render request keeps its original absolute deadline, so later padding shrink,
capture conversion and graph work all spend the same hardware budget. If
capture was selected and render appears during its drain, the owner polls that
render event once immediately afterward: exclusive mode conservatively keeps
capture-start QPC, while shared mode takes a new coherent post-drain
QPC+padding pair. If the render request still outruns capture by an event
boundary, that same request remains pending on capture. Shared mode may use
only the time represented by render frames already queued in WASAPI; exclusive
mode has no padding query and uses at most one exact render-frame period. Both
keep a one-millisecond scheduling guard and neither sleeps nor spins. Capture
arriving inside that bounded hardware budget services the request once.
A stop wins, and a timeout/late capture records a deadline miss and xrun and
fails the session instead of presenting stale or zero input as clean. It then
reads the FIFO into prepared planar input,
supplies zeros and an xrun on
underflow, invokes the `noexcept` graph thunk, then clears the entire
interleaved endpoint buffer before copying selected output lanes. FIFO overflow
drops the newest capture packet and marks the next delivered span
discontinuous. No queue imbalance is hidden: current/minimum/maximum FIFO
fill, underflows and overflows are status diagnostics. The separate
`acceptedCaptureMinusRenderedFrames` value is exactly the number of capture
frames accepted into the FIFO minus frames requested by render callbacks. It
is queue-flow evidence, not by itself a clock-drift estimate.

Startup remains capture-first: in shared mode the stopped render client is
filled with its silent endpoint buffer before capture starts, so no setup work
remains after the first capture period arrives. Render does not start until
capture has prepared exactly one negotiated render period; there is no added
safety period. Exclusive mode performs its silent prime only after capture
prefill, but still before render `Start`; a prime `GetBuffer` failure is a
bounded start failure and never waits for a render event that cannot exist
before `Start`. The silent buffer submitted to WASAPI before `Start` is
intentional endpoint priming. If a graph callback is still
within that bounded endpoint-priming window, its absent capture frames are
reported separately as `startupInputZeroFrames`; this means priming-window
input supplied as zero, not generic or detected silence. It is not counted as
a runtime FIFO xrun. Any shortage after the window is a surfaced underflow.

The hot paths allocate no memory, take no locks, log nothing, do not sleep or
poll, and perform no activation or property calls. Stop decisions read the
release-published control-stop atomic plus one coherent route lost/lifecycle
snapshot; the control event only blocks or wakes the owner and is not repeatedly
polled with zero-time waits. Portable callback counters
and FIFO cursors remain lock-free 32-bit values for 32-bit mobile targets. The
Windows-only accepted/render-requested/priming telemetry uses lock-free,
saturating uint64 counters, so it remains exact until the uint64 horizon rather
than wrapping after roughly a day. Separate-device clocks and adaptive resampling are deliberately
deferred even though same-container capture/render endpoints can still drift.
An exclusive-mode `AUDCLNT_E_BUFFER_ERROR` from `GetBuffer` marks an
xrun/discontinuity and retries on the next event; three consecutive acquisition
errors fail the stream. `ReleaseBuffer` is never retryable: capture/FIFO or
graph state may already have advanced, so any failed release is terminal and
cannot duplicate a packet or graph invocation. Normal teardown checks render
`Stop` then capture `Stop`; `S_FALSE` is success, while the first failed stop is
preserved as `DeviceLost` for invalidation results or `Error` otherwise.

`IMMNotificationClient` is mandatory and armed before endpoint pairing is
revalidated or profiles are prepared. Its callbacks only publish independent
atomic route state and signal the stop event. Selected endpoint deactivation,
removal, ContainerId change, or active/OEM device-format change fails closed as
`DeviceLost`; unrelated friendly-name, icon, volume, and effect property
changes do not invalidate an exact session. Route generation advances before
loss is release-published, and Open/Running publication cannot overwrite a
concurrent loss or worker error. Reopening is required. Default changes do not
reroute explicit UIDs. The callback remains alive through successful unregister. If Windows
refuses unregister, its callback, enumerator, and event are quarantined rather
than risking a late call into freed memory.

`IAudioClient::GetStreamLatency` is reported in the diagnostics structure as
100-nanosecond stream latency. It is not labeled as pure hardware or added to
the portable device-latency fields.

## Existing capture-only analysis path

Phase 3B does not replace the existing `AudioInput` provider used by live vocal
analysis. `WasapiAudioInputBackend` remains a separate capture-only path with
its `wasapi:`-namespaced UIDs, one selected float32 lane, the shared analysis
transport, and its established hardware-versus-estimated timestamp contract.
Inventory, initial low-period setup, and legacy fallback now all execute the
same real operation: Activate → checked `AudioCategory_Other` properties →
`GetMixFormat`. If that property cannot be applied, the operation fails instead
of ignoring the error. This is
independent of the new AudioHost endpoint identity and render lifecycle.

## Headless validation

Inventory:

```powershell
singz-audio-host.exe
```

Bounded muted shared run (zero-based channel maps):

```powershell
singz-audio-host.exe --run `
  --input-device-uid '<capture endpoint ID>' `
  --output-device-uid '<render endpoint ID>' `
  --input-channels 0 --output-channels 0,1 `
  --rate 48000 --buffer 480 --maximum-frames 8192 `
  --milliseconds 1000
```

Add `--exclusive` for an explicit exclusive attempt. Add `--cycles 10` to
exercise repeated open/start/stop on the same host object. Every completed
cycle is validated immediately and the harness stops at the first strict
failure, retaining its counters and terminal state. Channel-list options occur
at most once and accept only strict comma-separated unsigned decimal values—no
whitespace, signs, empty items, or overflow. The output JSON
includes mode, periods, endpoint buffers, stream latencies, FIFO extrema,
accepted-capture-minus-rendered frame balance, startup input-zero frames,
callback/xrun/deadline/invalid-callback/render-failure counters, input peak,
and terminal state. Strict runs return nonzero for any xrun, FIFO underflow or
overflow, deadline miss, startup input-zero frame, invalid callback, render
failure, zero-callback run, or terminal state other than `Stopped`.

### Dell/Realtek checkpoint evidence

The third-pass architecture snapshot was validated at
`C:\Users\123\singz-win-audio\phase3b-b5e7e4f-v20`. Windows reported these
active `eConsole` endpoints:

- capture `{0.0.1.00000000}.{cce5127f-502c-4d35-8031-304da1855d97}`;
- render `{0.0.0.00000000}.{3f4e314e-b1e2-4a68-9686-795e82879133}`.

Both active profiles were 48 kHz. `IAudioClient3` reported minimum, maximum,
preferred, and fundamental shared periods of 480 frames; the initialized
endpoint buffers were 1,056 frames. These are the Realtek driver profile, not
a SingZ-selected floor or buffer policy. The focused AudioHost and callback-
policy suite passed 7/7. The exact v20 one-second strict run completed 101
callbacks / 48,480 frames with zero strict faults. Its 50 immediate 50-ms
lifecycle cycles all completed with 315 callbacks / 151,200
frames, no failed reopen, and zero xruns, deadline misses, FIFO faults,
startup input-zero frames, invalid callbacks, or render failures.

Evidence history is intentionally retained:

- implementation snapshot v6 once completed 3,001 callbacks / 1,440,480
  frames clean;
- an independent verifier then reproduced one FIFO underflow and one xrun in
  each of two 30-second runs of the then-current bytes, while its one-second
  and ten-cycle gates were clean;
- after the publication-order and first consolidated review fixes, snapshot
  v8 completed two strict 30-second muted runs with exit 0. Each delivered
  3,002 callbacks / 1,440,960 frames and ended `Stopped`, with zero xruns,
  deadline misses, FIFO under/overflows, startup input-zero frames, invalid
  callbacks, and render failures. FIFO minimum/maximum were 0/480 frames in
  both runs. The first ended at 480 queued frames with exact
  accepted-capture-minus-rendered balance +480; the second ended at 0/0;
- after the second consolidated fixes, snapshot v12
  produced one clean 30-second strict run and one failed run. Both delivered
  3,002 callbacks / 1,440,960 frames and ended `Stopped`, with no deadline
  misses, overflow, startup input-zero frames, invalid callbacks, or render
  failures. The clean run had FIFO min/max 0/480, ended at 480 queued frames,
  reported accepted-capture-minus-rendered balance +480, and exited 0. The
  other had FIFO min/max 0/960, ended at 960 queued frames, surfaced one FIFO
  underflow and one xrun, reported the same +480 balance, and exited 4;
- the first single-owner snapshot v15 passed its one-second and 50-cycle gates
  but its first 30-second strict run surfaced 480 startup input-zero frames;
  v16's stronger setup ordering then surfaced a true one-second FIFO underflow.
  Neither result was waived. They established that the independent endpoint
  event phase, not only cross-thread FIFO publication, needed coordination;
- v17 keeps exactly one 480-frame FIFO prefill and holds an early shared render
  request only within the 1,056-frame endpoint buffer's already-queued padding
  budget. Five consecutive strict 30-second runs all exited 0. Their callback /
  frame counts were 3,001 / 1,440,480; 3,001 / 1,440,480; 3,002 / 1,440,960;
  3,001 / 1,440,480; and 3,002 / 1,440,960. Every run ended `Stopped` with zero
  xruns, deadline misses, FIFO under/overflows, startup input-zero frames,
  invalid callbacks, and render failures. FIFO minimum/maximum was 0/480 in
  all five; final queue balance was either 0 or +480 at the stop boundary.
- the final-audit v20 snapshot adds bounded exclusive pending-capture
  coordination, acquisition-only buffer-error recovery, terminal failed
  releases, loss-aware callback boundaries, checked stream stops, exact
  exclusive channel probing, and strict channel-list parsing. Five consecutive
  strict 30-second runs all exited 0. Their callback / frame counts were 3,001 /
  1,440,480; 3,001 / 1,440,480; 3,002 / 1,440,960; 3,002 / 1,440,960; and 3,002 /
  1,440,960. Every run ended `Stopped`, FIFO minimum/maximum was 0/480, final
  queue balance was +480, and every xrun, deadline, FIFO fault, startup input-
  zero, invalid-callback, and render-failure counter was zero.
- the final small-fix snapshot v21 centralizes normal and failed-start
  shutdown ordering, finalizes open errors from the post-join route snapshot,
  and rejects an expired pending render before FIFO-ready work. Its focused
  Windows/policy suite passed 7/7. The strict one-second run exited 0 with 102
  callbacks / 48,960 frames, and all 50 immediate lifecycle cycles completed
  with 323 callbacks / 155,040 frames; every strict fault counter was zero.
  Two consecutive strict 30-second muted runs each exited 0 with 3,002
  callbacks / 1,440,960 frames, ended `Stopped`, kept FIFO minimum/maximum at
  0/480 and final balance at zero, and reported zero xruns, deadline misses,
  FIFO faults, startup input-zero frames, invalid callbacks, and render
  failures.

The v21 exact-float 48-kHz/480-frame exclusive attempt failed explicitly with
exit 2 because this Realtek capture endpoint exposes no matching exact float32
exclusive channel profile; there was no shared-mode fallback. Successful
exclusive hardware is therefore not claimed by this checkpoint; deterministic
exclusive owner/protocol seams cover it. The existing `singz-analyze live-input`
path also completed a one-second regression with `ready`, 101 delivered
blocks / 48,480 frames, zero overruns, and `ended`/`stopped`. Its low nonzero
RMS proves data delivery, not an audible or sung-input test. The one-second
latency record correctly did not claim the separate 500-sample acceptance gate.

The five-run v20 architecture sequence plus the two exact v21 final-fix runs
close the reproduced event-phase regression on this machine without a second
software queue period. Same-container endpoints still do not contractually
imply sample-locked clocks. Longer product qualification must continue to fail
on and expose any padding-deadline or queue imbalance rather than hiding it
with drop/dup or an adaptive resampler.

ASIO remains a distinct future provider behind the existing fail-loud SDK/legal
gate (`SINGZ_ENABLE_ASIO` plus a separately obtained `SINGZ_ASIO_SDK_DIR`). It
must not be implemented as a fallback hidden inside WASAPI.

The portable FIFO hot methods are required members of the callback policy scan.
Its prepared owning header remains outside that token scan because it contains
off-RT vectors. The Windows event-loop bodies still share the large provider
translation unit with COM/SDK ownership code; extracting those hot bodies into
a separately compiled/scanned leaf is explicit pre-product-cutover debt, not a
claim that the entire provider file currently receives the portable RT scan.
