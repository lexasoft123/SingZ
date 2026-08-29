# ADR 0010: Guarded desktop monitoring preview

Status: implemented; native path hardware-verified on macOS, app-shell
persistence awaiting human listening verification
Date: 2026-08-29

## Decision

The first audible DSP integration is a deliberately narrow desktop monitoring
preview behind the existing packaged `singz-capture` Node-API addon. One
control-domain `AudioMonitorSession` owns an ephemeral prepared arena, five
built-in processors, compiled graph, one immutable published snapshot,
parameter queue, runner, `AudioHostGraphAdapter` and `AudioHost`. Its only
graph is capture Peak/RMS -> Gain -> ChannelMap -> SafetyLimiter -> output
Peak/RMS. The limiter ceiling is fixed at -1 dBFS.

The session begins muted. A caller must explicitly provide `enabled=true` with
a bounded finite gain in [-60, +12] dB; every change becomes a bounded linear
gain event instead of a discontinuous scalar write. Selected physical input
and output channels are explicit zero-based arrays. A mono input duplicates to
every selected output; equal-width buses map one-to-one; remaining unequal
layouts map matching leading channels and leave unmatched outputs silent.

Node-API transports only bounded configuration, generation-bound commands,
device/format/latency diagnostics and pre/post scalar meter readings. It never
transports PCM, a graph description or a native pointer. There is no graph
persistence in this preview.

The product `DesktopMonitorCoordinator` must first stop and release Web Audio
output, then hand the same ownership generation to `beginMonitor`. Enumeration
alone does not acquire audio. `beginMonitor` does not start when another native
capture or monitor generation owns the addon microphone. Arbitration is
fail-closed in both call orders. A successfully accepted monitor generation
advances a retained high-water mark, so a reused/lower begin and a delayed old
end cannot affect a newer session. Teardown stops and joins `AudioHost`, then
shuts down the runner and deactivates/destroys the graph before releasing its
arena. A busy runner shutdown or failed graph deactivation retains the prepared
graph and arena for an explicit same-generation retry. Object destruction stops
the host first and quarantines still-live graph storage instead of freeing it.
Renderer occlusion and ordinary device-inventory notifications do not end an
explicitly enabled monitor: Electron reports a fully covered macOS window as
`document.hidden`, but this audio session is not renderer animation work. The
native loss/status path remains authoritative.

Phase 4A.1 makes `DesktopMonitorCoordinator` a long-lived app-shell owner.
Settings registers its temporary preview stopper and subscribes to the shared
snapshot, but normal Settings close only unmounts that view and releases the
meter preview. An active native generation remains visible in the top bar with
separate Open Settings and Stop buttons. Reopening Settings reads the same live
snapshot instead of constructing a second coordinator. While native ownership
is retained, song output stays released to Chromium's silent sink, song play is
refused, and song/training microphone capture remains blocked. Explicit Stop,
editing a physical route, a terminal native failure, a Settings runtime error
or renderer teardown still ends the exact generation before Web Audio output
is restored. App restart never restores the enable decision.

The Chromium preview has its own truthful safety lease. A healthy registered
preview blocks song/training starts and remains reachable by the app-shell
coordinator, but it is not unresolved cleanup and does not show the top-bar
control. A
Settings unmount marks that lease unresolved before awaiting `stopAndWait` and
does not discard it until the capture child confirms it stopped; pending or
failed cleanup keeps the top-bar Stop/retry control visible. A later Stop
retries the same preview owner, and Web Audio is restored only after both
preview cleanup and native generation shutdown are confirmed. Song, training
cues and training capture are cancelled once more immediately before
restoration, so work queued against the silent sink cannot become audible. A
Settings chunk-import rejection preserves whatever preview/native/route owner
the app shell already records; loading UI does not invent an owner or run
cleanup. After the Settings module has loaded, its runtime-only boundary has
eager app-shell emergency-stop handles and uses them for first-render or later
descendant faults. Import recovery and loaded-view runtime recovery are thus
separate paths.

Vocal Training cleanup is intentionally owned by a different app-lifetime
coordinator. Any Training-to-other-section transition is retained until cues,
song playback and the exact training microphone have confirmed release; a
failure leaves the Training route and its Retry surface mounted. That lease
blocks song, Settings and training-audio entry, but its UI never claims native
headphone monitoring, an output-route transition, or availability of the
monitoring Stop control.
That cleanup UI sits outside Training's recoverable module boundary, and thus
survives loading or either chunk-import failure. App teardown disposes the
coordinator before the training microphone and cue owners; late stop settlement
is generation-invalidated and cannot navigate or update renderer state.

Physical-route edits use one app-lifetime, invocation-ordered queue across
playback output, input device/lane, native monitor output and playback lanes.
The queue is constructed beside the monitor coordinator, not inside Settings,
so an immediate close/reopen cannot create a concurrent drain. Scheduling an
edit immediately acquires a coordinator-visible transition lease; the lease
survives Settings close and releases only after that edit's browser/native
apply promise has settled. The browser handoff is awaited fail-closed: if the
OS stalls, the lease and “Changing audio route…” top-bar indicator remain until
settlement or app quit. There is no Stop button for this non-cancellable apply,
because releasing the lease while a late sink write can still arrive would be
unsafe; Open Settings remains available. A reopened Settings preview stays
dormant under the shared route/unresolved-cleanup lease and starts
automatically when the change-gated shell snapshot clears it.

The queue stops preview/native ownership once per batch, applies every captured
selection serially, and can restart a mounted, visible preview only after the
final edit. Boot/device-change Web Audio reconciliation and direct playback
selection also share one app-lifetime latest-intent arbiter. Direct selection
publishes its desired output/version synchronously, stale inventory results are
discarded before sink writes, and preferences commit only after the current
handoff succeeds. A failed current handoff restores the last committed intent
before queued repair. The final cancellation barrier runs only when Web Audio
was physically released and is about to be restored; preview-only cleanup does
not pause a song or cancel cues.

The app shell subscribes only to change-gated phase/ownership/safety state,
including route-transition and pending-stop leases. A stop lease clears only
after all teardown/restoration callbacks settle. Delayed telemetry responses
recheck both ownership generation and active phase, so an explicit Stop cannot
be overwritten by an old terminal rejection.
Settings owns the detailed 120 ms telemetry subscription; meter and callback
counter changes therefore do not rerender the full player or training tree.

macOS accepts only one same-UID duplex device and is the only enabled Phase 4A
product preview. Windows inventory remains visible, but its platform-backed
`beginMonitor` returns typed `platform-not-ready` until the WASAPI event-loop
hot body is extracted into the enforced real-time policy target. The injected
manual backend remains available to the same cross-platform contract tests.
When Windows is enabled it will accept only the paired capture/render endpoint
contract already enforced by `AudioHost`, with an exact common requested rate;
no monitor-layer rate conversion, clock drift correction or fallback is
invented. ASIO remains separately gated. Bluetooth, AirPlay and vehicle routes
are not low-latency monitoring routes. CoreAudio inventory publishes typed
transport and monitoring-suitability capabilities; `beginMonitor` accepts only
a provider-confirmed low-latency duplex route. High-latency and unknown routes
are rejected with typed `unsupported-route`; labels and UIDs are never parsed
to infer transport.

The callback thunk, output silencing and terminal counters live in their own
strict no-exceptions/no-RTTI target whose actual sources are realtime-policy
scanned. It invokes only the prepared host adapter and lock-free telemetry and
allocates, locks, logs and bridges nothing. Invalid blocks, graph errors and
device-loss boundaries zero every output channel and increment truthful failure
state. Adapter render failures and intercepted terminal/device-loss failures
are separate exact counters. Gain discontinuities adopt the most recent ramp
target, so an interrupted mute cannot freeze half-audible. The initial mute and
final safety limiter cannot be removed by configuration.

## Non-goals

This phase does not migrate song sources or transport, mix native and Web Audio
outputs, record audio, expose a general graph editor, persist a graph, host a
plug-in, add mobile product wiring, or claim an audible hardware result from an
automated silent test.

## Acceptance

- Deterministic manual/fake-host numerical tests prove mute, ramped gain,
  mono-to-stereo mapping, limiter ceiling, both meters, generation rejection,
  typed route rejection, exact failure counters, device-loss silence,
  retryable teardown and stop-before-release/quarantine order.
- The steady-state render call passes the allocation trap; the actual monitor
  callback leaf is built and scanned in strict Release, ASan/UBSan and TSan
  presets.
- The Electron smoke validates every export, bounded result schema, lossless
  generation BigInts and malformed integer/boolean rejection without starting
  hardware or producing sound.
- Release CTest, addon build/verification, ASan/TSan and platform compile gates
  pass before product UI wiring begins.
- Product tests prove the exact UID/channel handoff, fresh wired-headphone gate,
  off-by-default and non-persistent enablement, Web Audio release/restore order,
  app-shell persistence across Settings close/reopen, global Stop single-flight,
  route-edit and failure cleanup, truthful named host telemetry, and blocked
  Windows/unsuitable-route copy. Electron E2E probes the silent Web Audio sink
  release but never calls the audible native begin operation.
- Human listening on 2026-08-29 verified Zen Quadro SC input 3 through the
  native graph to USB playback outputs 1/2. Monitoring remained audible while
  switching to another macOS app. That evidence predates app-shell persistence;
  listening after normal Settings close plus restoration through the top-bar
  Stop action remains pending.

## Consequences

SingZ gains one real product composition boundary for hearing built-in DSP,
while current song playback remains unchanged until the coordinator performs
the explicit lease handoff. Cross-device drift, mobile sessions, recording and
the general configurable graph remain later independent phases.
