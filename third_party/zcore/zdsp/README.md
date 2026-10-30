# zdsp ownership

`zdsp` is the native real-time processing graph. Phase 1 keeps the Phase 0B
same-toolchain C++20 contracts and adds an isolated graph kernel without taking
ownership of app playback:

- `SingZ::zdsp_api` exposes graph/processor contracts and depends only on
  `SingZ::zcore_base`. It intentionally owns DSP-facing clock, bus, process and
  strong-unit types; device/capture transport remains in `zcore_audio` and a
  higher host layer adapts between them;
- `SingZ::zdsp_analysis` is that explicit ordinary-delivery-domain adapter for
  capture analysis. It maps typed provenance, owns bounded peak/RMS and live
  pitch windows, and emits copied scalar evidence; it is not callback
  reachable, an output host or a product bridge. During migration it links the
  narrow `zcore_live_analysis_compat` YIN target, which composes the neutral
  `zcore_resample` converter, so legacy and new delivery paths cannot drift;
- `SingZ::zdsp_runtime` contains contract validation, the fixed-capacity graph
  compiler, arena-backed buffer/latency plan, built-in processors, serial
  runner, decoded-buffer source, immutable publication and epoch retirement.
  The source copies only borrowed planar pointers into fixed state; its
  control-domain owner must outlive graph teardown. The callback-reachable
  source starts at frame zero and preserves its cursor on generic resets;
  positioned seek/loop requires the future transport contract. The runtime
  target is compiled without exceptions/RTTI and scanned from actual target
  membership for forbidden RT facilities;
- `SingZ::zdsp_offline` renders the same compiled graph deterministically and
  emits canonical little-endian float WAV bytes. It owns no codec dependency;
- `SingZ::zdsp_prototype` contains the gain→meter fake host for tests and
  benchmarks. It is excluded from default builds and forbidden from product
  linkage;
- `SingZ::zdsp_control` contains the deterministic graph contract fixture codec.

The Phase 0B fake host remains test-only. Production graph descriptions use
stable 64-bit node and 128-bit type IDs, explicit mono/stereo/discrete buses and
a cycle-free DAG. Compilation is transactional: it prepares a complete graph,
queries latency after prepare, inserts explicit edge compensation, grants
in-place aliases only at the last live consumer, and pins external input/output
values across the real callback boundary copies. Non-null processor state
pointers are unique lifecycle owners across the description; aliases are
rejected before prepare or arena mutation even when their vtables differ.
Successful rollback rewinds
the arena; a failed deactivate/destroy instead preserves a retryable quarantine
handle and checkpoint, so live processor storage is never reclaimed. A failed
compile cannot replace or mutate the active graph.

The callback adopts an immutable snapshot only at a block boundary. A prepared
retirement slot is reserved before publication, newer unpublished edits replace
older ones, and saturation leaves only the latest deferred edit on the control
domain. Old snapshots become reclaimable only after the serial render epoch no
longer references them; processor deactivation/destruction remains an explicit
off-RT call. Generation zero is the unpublished sentinel; publication starts at
one. Render atomically claims one pending pointer before inspecting it; a short
lock-free publication handoff plus atomic pending/claimed/active/fading/retired
ownership views prevents duplicate graph ownership while the pointer moves. On
adoption the old snapshot is first published into its reserved fading/retirement
ownership, then the replacement becomes active, and only afterward may the old
slot become reclaimable; neither graph is absent from all views at any stage.
Rejected topology/rate/storage changes enter the same bounded off-RT retirement
path without advancing the active graph. A rejected claim first publishes its
reserved non-reclaimable slot ownership, then clears the claimed view, and only
afterward marks the slot waiting/reclaimable; control reclamation ignores
Reserved slots. Topology changes use a bounded caller-
budgeted crossfade, history-primed latency alignment, actual silent-input finite
tail drain, distinct infinite Reject/Fade/Cut behavior and combined-CPU
admission check. A crossfade endpoint is split at its exact frame even when it
lands inside a callback; the remainder immediately uses an explicit tail-drain
context with silent inputs, empty events and inactive transport. Transition
plans are identity-bound to both graph pointers and generations. The old-path
gain reaches exactly zero at the crossfade endpoint and remains zero during the
bounded spill, which drains state silently without restarting its envelope.
Topology-compatible transitions support every external output bus: reserved
scratch, history and alignment lanes use overflow-checked flattened offsets,
while rendering and mixing retain each logical bus descriptor and channel
layout. Capture provenance is preserved through one-source transforms, delayed alongside audio
through intrinsic and compensation delay state, invalid during warmup/reset,
and cleared at synthetic or fan-in boundaries.

Every typed reset-state discontinuity cancels an in-flight fade/tail at that
exact boundary, retires the old snapshot off RT, clears alignment/output/capture
delay history, and resets the active graph before its affected block. Once the
render caller has quiesced, `shutdownGraphRunner` extracts every pending,
claimed, active, fading, rejected and retired snapshot into bounded caller-owned
storage for off-RT teardown. It returns `Busy` without mutation if a callback is
in flight and rejects insufficient output capacity without partially draining
ownership.

The built-in set is gain, channel map, mix, delay compensation, peak/RMS,
oscillator, bounded tap and safety limiter. Gain, oscillator and limiter ramps
persist across blocks and zero-frame flushes. Meter/tap readers receive coherent
current-block copied snapshots from generation-indexed slots with a per-slot
version guard, including when a slow reader spans repeated slot reuse. Every built-in
contains non-finite samples before downstream processing. Unary built-ins require
one layout-compatible equal-width input/output pair; Mix requires one or more
inputs matching its output shape, ChannelMap alone may transform widths through
a finite validated matrix, and Oscillator is source-only. Factory scalar
contracts reject non-finite values before state construction: gain is finite,
the safety-limiter threshold is `(0, 1]`, and oscillator frequency/amplitude
are respectively non-negative and `[0, 1]`; prepare additionally limits the
initial oscillator frequency to Nyquist for the selected sample rate. Fixed SPSC queues
carry typed parameter and musical events; overload preserves the newest safely
accepted value per node/parameter, refreshes recency on replacement, and keeps
FIFO musical ordering at equal offsets. A callback snapshots both consumer-visible
queue counts only after a renderable graph passes preflight and consumes no more
than those captured counts; concurrent replenishment belongs to the next normal
block, while empty/rejected/tail-drain calls leave both queues untouched.
Callback diagnostics use an always-lock-free
32-bit counter width and publish accumulated non-finite counts once per graph
pass; control code widens sampled deltas.

Android links this runtime through the existing inert `zdsp_runtime` product
dependency. The transitional iOS pod now includes capture analysis and the
decoded-buffer source foundation alongside the Phase 0B contracts; the full
graph runtime and product routing remain part of the separately owned native
packaging/XCFramework cutover. Neither platform routes app audio through the
graph yet. `zdsp_apple_component_smoke` is the checked-in inert packaging gate:
it builds strict hidden-symbol device arm64 and simulator x86_64 static archives
and rejects product/platform dependencies without touching the pod or audio
session.

Product UI, Electron/React Native marshalling, platform framework types and
codec/ML/plugin dependencies do not belong in `zdsp_api` or its callback path.
This C++ interface is not a shared-library or plug-in ABI; ADR 0001 reserves a
future explicit C adapter for those boundaries.

## Phase 1 verification fixtures

`zdsp_graph_tests` covers arena rollback, topology and port validation,
description-order-independent scheduling, exact lifetime/in-place/fan-in/out
planning, deterministic latency compensation and bypass, every typed
discontinuity, transition and retirement saturation, queue overflow,
non-finite containment, allocation traps, concurrent publication/reclamation,
and callback-partition-invariant offline rendering. The embedded golden fixture
is a 480-frame mono float WAV generated by saw oscillator → gain → limiter:

- PCM FNV-1a: `456813383480480899`
- WAV FNV-1a: `4446233685677010001`
- WAV bytes: `1964`

`zdsp_graph_benchmark` separately reports individually timed full-graph and
empty-graph calls, the timer/validation harness, and explicitly labelled
32-call throughput averages. Only individual samples contribute individual
maxima and deadline-miss claims.

Run `zdsp/run-sanitizer-gates.sh` on Linux or macOS to execute the checked-in
strict Release, ASan+UBSan and TSan graph presets; unsupported hosts exit without
making a sanitizer claim. CI runs the same script on Ubuntu. The graph test
executable counts global C++ allocations while rendering and the runtime exposes
`inGraphRenderCallback()` so project-owned synchronization wrappers can reject
callback-domain lock acquisition. These instruments cannot observe allocation
or synchronization hidden inside the C/C++ standard library, platform runtime,
driver, or operating system, so source-policy scans and physical-host gates
remain complementary rather than being described as a universal lock trap.
