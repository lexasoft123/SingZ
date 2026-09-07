# Low-latency DSP implementation research

Status: research basis for [DSP-GRAPH-PLAN.md](DSP-GRAPH-PLAN.md)

Last reviewed: 2026-08-26

Language, library and source/target layout decisions are specified in
[NATIVE-CORE-DESIGN.md](NATIVE-CORE-DESIGN.md).

This note distils primary platform documentation and production open-source
audio engines into implementation rules for `zcore` and `zdsp`. It covers
real-time execution, graph mutation, buffer ownership, scheduling, hardware
acceleration, device drivers, latency measurement and plug-in isolation. It is
not an instruction to copy another project's implementation: several useful
references have copyleft or commercial-license constraints.

## Executive recommendation

SingZ should begin with a portable CPU graph whose entire normal block executes
on the device-owned real-time thread. The graph compiler runs elsewhere and
publishes an immutable, fully prepared execution plan at a block boundary.
That plan contains a topologically ordered operation list, preallocated and
liveness-reused planar float32 buffers, explicit format adapters, accumulated
latency and bounded analyzer taps.

The initial graph should be deliberately single-threaded. Per-node threads
increase wakeups, synchronization and jitter and make small blocks slower.
Parallel execution can be added later for independent expensive branches using
a fixed, pre-created real-time worker pool. GPU processing should likewise be
an optional high-latency/coarse-work backend, not the default path for filters,
meters or short vocal-effect chains.

The most important contract is not “zero copies at any cost.” It is **zero
unnecessary copies inside one real-time clock domain**. Device buffers are
ephemeral, thread boundaries need owned storage, and different hardware clocks
need a FIFO plus drift correction. A bounded deliberate copy is safer than
retaining a driver buffer or blocking the callback.

## What established engines teach us

| Project | Relevant design evidence | SingZ disposition |
| --- | --- | --- |
| [JACK2](https://github.com/jackaudio/jack2) | Lock-free graph changes, SMP execution and explicit synchronous versus asynchronous client modes. Its [SPSC ring buffer](https://jackaudio.org/api/ringbuffer_8h.html) exposes two-span read/write vectors. | Adopt the immutable/snapshot and SPSC ideas. Do not add asynchronous previous-block semantics unless it is an explicit degraded-survival mode. |
| [PipeWire](https://docs.pipewire.org/group__pw__stream.html) | Real-time process flag, buffer dequeue/queue and `NO_CONVERT`; SPA buffers may use pointer, file-descriptor or DMA-BUF storage. | Reference for Linux and for honest zero-copy capability negotiation. Do not make DMA-BUF a portable graph assumption. |
| [JUCE AudioProcessorGraph](https://docs.juce.com/develop/classjuce_1_1AudioProcessorGraph.html) | Graph updates are prepared away from processing; a compiled rendering sequence reuses intermediate buffers; processors must accept variable blocks, including zero samples. | Reproduce the contracts and tests, not the implementation. Adoption of JUCE itself requires a separate licensing/product decision. |
| [Ardour](https://github.com/Ardour/ardour/blob/master/libs/ardour/audioengine.cc) | The engine callback is explicitly real-time, latency changes are deferred, failed non-blocking coordination becomes an xrun, and latency measurement has a dedicated path. | Study mature failure handling and measurement. GPL code must not be copied into closed SingZ. |
| [Tracktion Engine](https://github.com/Tracktion/tracktion_engine/blob/develop/FEATURES.md) | Multi-CPU render strategies, plug-in delay compensation, lock-free FIFOs/file writing, reusable scratch buffers and rack graphs. A reported [RCU lifetime bug](https://github.com/Tracktion/tracktion_engine/issues/200) shows that retaining an old node can preserve unintended RAII side effects. | Make snapshot retirement and node side effects explicit and testable. Tracktion/JUCE licensing prevents casual embedding. |
| [Carla](https://github.com/falkTX/falkTX/blob/main/README.md) | Supports internal patchbays, one-client-per-plug-in and all-plug-ins-in-one-client modes, plus bridged plug-ins using shared memory, semaphores and IPC. | Offer explicit in-process low latency versus bridged crash isolation. Never hide the extra bridge buffering/latency. |
| [MOD Host](https://github.com/moddevices/mod-host) | Separates socket control from an LV2/JACK real-time host and supports worker/state/time extensions. | Keep control, state and slow worker work out of `process()`. Study only; GPL. |
| [Guitarix](https://github.com/brummer10/guitarix) | A mature modular JACK amp/effects chain with convolution, neural amp models and LV2/VST hosting, including headless hardware. | Useful workloads and presets for benchmarks. Study only; GPL. |
| [Neural Amp Modeler](https://github.com/sdatkinson/NeuralAmpModelerPlugin) | Permissively licensed real plug-in that stages neural models and impulse responses outside the processing callback before adoption. | Reuse the prepare-then-publish pattern and include official plug-in validation in future gates. |
| [RTNeural](https://github.com/jatinchowdhury18/RTNeural) | BSD-licensed real-time inference with Eigen, xsimd and STL backends; its own guidance is to benchmark the model because the best backend varies. | Candidate for a future prepared neural processor, with scalar parity and per-target benchmarks. |
| [iPlug2](https://github.com/iPlug2/iPlug2) | Permissive cross-platform plug-in framework spanning VST3, AU, AUv3 and CLAP. | Evaluate later for adapter/test-host leverage; do not let a framework own the core graph. |
| [miniaudio](https://github.com/mackron/miniaudio) | Callback device layer and node graph in one file. Native device format avoids internal conversion; fixed-size callback adaptation requires an intermediate buffer. | Excellent comparison implementation. SingZ still needs richer clock, physical-channel and route-generation contracts than its portable abstraction exposes. |
| [RtAudio](https://github.com/thestk/rtaudio) | Small common callback API over Core Audio, WASAPI and ASIO with non-interleaved, exclusive/hog and latency-minimization options. | Useful HAL comparison, but hidden conversion and ASIO licensing do not disappear behind the wrapper. |

The shared lesson is separation of time domains: a small hard-real-time data
plane and an ordinary control plane. Graph construction, plug-in scanning,
file access, model loading, FFT plan creation, memory locking and device
reconfiguration all belong to the latter.

## Real-time execution contract

The render callback may only:

- read the current prepared snapshot and bounded parameter/event queues;
- acquire buffers already assigned by the snapshot;
- execute bounded DSP with no first-use initialization;
- write driver buffers and lock-free counters;
- publish bounded analyzer slabs or discontinuity markers with a non-blocking
  try operation;
- atomically advance the render epoch.

It must not allocate or free memory, perform file/network/IPC operations, log,
perform an OS/blocking wait, sleep, lock a mutex, start or stop the device,
discover plug-ins, build FFT plans, load a model, compile code, or perform an
unbounded retry. A narrowly bounded real-time spin join is permitted only by
the optional parallel-stage policy below. JACK's
[non-callback API guidance](https://jackaudio.org/api/group__NonCallbackAPI.html)
and Android's [low-latency checklist](https://developer.android.com/games/sdk/oboe/low-latency-audio)
state the same constraints.

Additional rules:

- Pre-fault and, where permitted, lock the arena and queues before starting.
- Establish floating-point mode before rendering; flush denormals to zero.
- Prove that every atomic used on the callback is always lock-free on each
  supported target. Pad frequently written producer/consumer state to separate
  cache lines.
- Do not destroy reference-counted objects on the callback; a final release can
  invoke an allocator or plug-in destructor.
- A device callback and `GraphRunner` accept 1 through the negotiated maximum
  frames. Processor and plug-in adapters must also tolerate a zero-frame call
  for parameter/event flushing without reading or writing audio buffers.
  Neither contract promises the preferred size every time.
- Measure callback CPU duration against the device deadline and expose p50,
  p95, p99, maximum and xrun/discontinuity counts outside the callback.

## Compile the graph; do not walk an editable graph

The UI edits a serializable `GraphDescription`. A control-side compiler then:

1. validates ports, channel layouts, cycles and capabilities;
2. requires any feedback edge to pass through an explicit delay node;
3. negotiates one native device format at the graph edge and inserts only the
   necessary layout/rate adapters;
4. topologically orders processors and constructs optional parallel stages;
5. calculates path latency and inserts compensation on reconverging branches;
6. performs buffer-liveness analysis and assigns reusable arena slots;
7. prepares every processor, FFT, resampler, plug-in and model for the maximum
   block size;
8. creates a bounded transition plan, such as a short crossfade;
9. publishes a complete immutable `ExecutionPlan` with one atomic exchange.

The render thread adopts a snapshot only at a block boundary. Retired plans
are tagged with an epoch and destroyed later by a control-side reclaimer after
no render worker can reference them. The retirement queue is bounded. If it
fills, editing applies backpressure to the control plane; the callback never
does reclamation.

Node lifetime semantics must be written down. A bypassed, disconnected or old
node must not keep MIDI, device, file or registration side effects merely
because an RCU snapshot still owns it. The Tracktion issue above is a useful
regression case: graph lifetime and resource lifetime are related but not
identical.

## Buffer ownership and practical zero-copy

The canonical internal bus remains aligned planar float32. Processors receive
non-owning views with channel pointers, frame count, capacity, sample position
and discontinuity flags. Ownership stays in the execution plan's arena.

The compiler may assign output in place only when the node declares it safe
and the input has no later consumer. Otherwise it assigns a preallocated slot.
Passthrough nodes alias their input. Mixing, fan-out and sidechain rules are
represented explicitly so a node cannot mutate another branch's input.

The final graph output may point directly at the device output buffer when its
format and layout match and the platform contract permits it. Likewise, input
can be viewed in place for the duration of the callback. Neither buffer may be
retained after return.

Copies are intentional at these boundaries:

- interleaved/non-interleaved or integer/float device conversion, performed
  once at the edge when native float planar access is unavailable;
- a processor that mandates a fixed quantum, isolated behind a preallocated
  reblocking adapter whose latency is declared;
- an analyzer or recorder leaving the callback, copied into a pool-owned slab;
- a plug-in process bridge, copied or mapped into a bounded shared-memory ring;
- two unrelated device clocks, joined by FIFO occupancy control and a
  continuously adjusted asynchronous resampler.

SPSC queues should expose acquired contiguous spans, like JACK's two-vector
ring interface, so producers and consumers can fill/read ring storage without
an extra staging copy. This does not make an ephemeral device buffer safe to
lend to another thread.

## Threading policy

### Default

One device-owned callback thread executes the complete graph. This gives the
lowest scheduling overhead, simplest causal order and clearest deadline.
Analyzers, disk writers and UI telemetry consume bounded queues on ordinary
threads and drop work rather than blocking audio.

### Optional parallel stages

Add parallel rendering only after profiles show that real SingZ graphs miss a
deadline despite optimized serial kernels. The compiler may group independent
expensive branches into antichain stages. Execution uses a fixed worker pool
created and promoted before device start:

- no task allocation, general work stealing or thread creation in `process()`;
- one preallocated job slot per stage/worker;
- a bounded real-time spin hand-off, never an OS wait, mutex or condition
  variable. Each join has a precomputed absolute budget that ends before the
  device deadline and records any miss;
- serial execution when the stage is too small or deadline margin is low;
- slot-private worker output: on a join miss the current block uses its
  prepared emergency dry/silent path and the entire parallel stage/processor
  generation—state and arena slots included—is quarantined until all workers
  acknowledge its epoch. Following blocks use an independently prepared
  fallback snapshot, not the same stateful processors in serial. Only after
  acknowledgement may the missed generation be retired, reset or reused, and
  no late worker may touch a returned device buffer;
- workers join the platform's audio scheduling domain where supported—Apple
  [Audio Workgroups](https://developer.apple.com/documentation/audiotoolbox/adding-audio-unit-auxiliary-real-time-threads-to-audio-workgroups)
  or Windows MMCSS “Pro Audio”; Android uses the available real-time/performance
  APIs without assuming every device grants them.

JACK2's asynchronous mode can keep a system alive by consuming the prior
cycle's output, but it adds a block of latency and changes feedback semantics.
If SingZ ever adopts such a survival mode, it must be visible in diagnostics
and must never silently activate for live vocal monitoring.

## SIMD, FFT and GPU acceleration

Optimization order should be:

1. correct scalar implementation with deterministic offline tests;
2. aligned planar storage, cache-friendly traversal and removal of redundant
   passes/copies;
3. compiler vectorization and fused simple built-in operations where automation
   and observable node boundaries permit it;
4. measured platform kernels—Apple
   [Accelerate/vDSP](https://developer.apple.com/documentation/accelerate/vdsp-library),
   or portable runtime-dispatched SIMD such as
   [Google Highway](https://github.com/google/highway);
5. measured FFT/convolution backends with plans created and warmed off-thread;
6. optional GPU nodes only for workloads large enough to amortize dispatch and
   synchronization.

Highway is attractive for runtime NEON/SVE/x86/WASM dispatch, but dispatch must
be warmed before audio starts. RTNeural likewise requires per-model/per-target
benchmarks rather than choosing a backend by reputation. Oversampling should
wrap only nonlinear nodes or subgraphs, never the complete graph by default,
and its filters and latency must be part of the compiled plan.

GPU processing is a poor default for a chain of small dependent kernels at
16–128 frame blocks. The experimental
[GPU Audio SDK](https://github.com/gpuaudio/gpuaudio-sdk) addresses this with
prepared blueprints, preallocated resources, batching, overlapping transfers
and discretized execution windows; those windows add latency. NVIDIA's
[CUDA Graphs](https://developer.nvidia.com/blog/cuda-graphs/) similarly
amortize host launch overhead only after an expensive graph capture and
instantiation step.

Therefore a future `zdsp_gpu` node must:

- prepare and warm a persistent execution graph outside real time;
- use pinned or unified preallocated buffers and asynchronous submission;
- declare at least its execution-window/block latency;
- never block the audio callback waiting indefinitely for the GPU;
- have a CPU fallback and a deadline-miss policy;
- demonstrate an end-to-end improvement at the supported small block sizes.

Likely candidates are long convolution, sufficiently large parallel neural
models and offline source separation. Biquads, gain, metering, small FFTs and
ordinary vocal chains stay on CPU SIMD. Apple unified memory removes a copy,
not synchronization or scheduling latency.

## Platform device layer

`zcore` should expose one narrow device/session contract with separate
per-platform implementations. Every backend reports the **actual** negotiated
rate, format, block range, physical channel map, stable device identity,
timestamps, route generation, xrun count and distinct latency components. It
must not silently hide a converter or shared/exclusive fallback.

### macOS and iOS

Core Audio uses a pull model: the output render callback is the natural graph
master. Cache an Audio Unit's render block and set maximum frames before
allocating resources, as required by
[`AUAudioUnit`](https://developer.apple.com/documentation/audiotoolbox/auaudiounit/renderblock).
AUHAL/RemoteIO should perform same-device duplex in that render domain. Separate
devices require an Aggregate Device that synchronizes clocks where available,
or SingZ's FIFO/drift-resampler path.

On iOS, preferred sample rate and I/O buffer duration are requests; store the
post-activation actual values. Route-change notifications create a new route
generation and graph discontinuity. Keep capture, DSP, output-device and
external-route latency separate. Apple's reported
[`outputLatency`](https://developer.apple.com/documentation/avfaudio/avaudiosession/outputlatency)
can be very large for wireless routes; AirPlay may reach seconds. Bluetooth,
AirPlay and CarPlay are presentation routes, not safe live-monitoring routes.

### Windows

The first-party default is event-driven WASAPI. In shared mode, use
`IAudioClient3` periods where supported. In exclusive mode, request the minimum
period and event callbacks, but fall back visibly because exclusive access is
not guaranteed. Microsoft's
[exclusive-stream guidance](https://learn.microsoft.com/en-us/windows/win32/coreaudio/exclusive-mode-streams)
describes WaveRT shared hardware buffers and MMCSS “Pro Audio” scheduling.
Use `GetBuffer`/`ReleaseBuffer`, endpoint padding and `IAudioClock2` device
position/QPC timestamps instead of inventing a wall-clock position.

ASIO remains an optional backend for professional interfaces. Steinberg's SDK
is [dual-licensed](https://github.com/audiosdk/asio/blob/main/LICENSE.txt):
GPLv3 or Steinberg's proprietary ASIO SDK terms. A closed-source SingZ
distribution needs the appropriate proprietary agreement before that backend
ships. The architecture must keep `WasapiAudioHost` and `AsioAudioHost` in
separate files/classes behind the same contract.

### Android

Use Oboe with the AAudio path where available, low-latency mode, an output data
callback and exclusive-mode request with a shared fallback. Match the device's
natural rate—normally 48 kHz—or let Oboe perform its quality resampling rather
than forcing an unsupported rate. Oboe's
[`FullDuplexStream`](https://github.com/google/oboe/wiki/Using-FullDuplexStream-for-Synchronized-IO)
uses the output callback as master, initially drains input, then keeps a small
input cushion; zero bursts is lowest latency and one is more stable.

Start with roughly two bursts/periods of buffering and monitor xruns. Oboe's
[`LatencyTuner`](https://github.com/google/oboe/blob/main/include/oboe/LatencyTuner.h)
demonstrates raising `bufferSizeInFrames` by one burst after underruns, up to
the capacity fixed when the stream was opened; this tuner behavior is
AAudio-only. SingZ should generalize that as a visible per-device stability
profile rather than allow a library heuristic to change monitoring behavior
invisibly.

## Clocking, latency and route truth

The output hardware clock is the graph master for audible real-time use. A
same-device duplex callback may consume input directly. If input and output
clocks differ, the graph must not pretend their nominal 48 kHz rates are the
same: it monitors FIFO fill and applies slow bounded ratio correction in an
asynchronous resampler.

Track latency as separate quantities:

- input hardware/driver latency;
- input adaptation or drift-resampler latency;
- graph algorithmic and compensation latency;
- process-bridge/reblocking latency;
- output hardware/driver latency;
- external presentation-route latency;
- timestamp quality and empirical confidence.

Do not collapse those into one number needed for every purpose. Capture
timestamps must stay raw; a singer-facing playhead uses estimated audible time;
scoring aligns the recorded input and reference through the measured graph and
device path.

Profiles should be explicit: `Low latency`, `Stable` and `Presentation`.
Begin low, watch xruns and add one hardware burst/period at a time. Never shrink
the buffer mid-performance without a long stable window and an explicit policy.
Persist only a per-device hint; always renegotiate after open or route change.

## Verification programme

The same compiled graph needs an offline runner for deterministic tests and
benchmarks. Required gates include:

- scalar/SIMD sample parity within declared tolerances;
- blocks of 0, 1, common burst sizes and negotiated maximum, including varying
  consecutive sizes;
- graph edits, plug-in/model replacement and bounded retirement under load;
- fan-out aliasing, in-place eligibility and arena high-water tests;
- sample-accurate parameter events and smoothing across block boundaries;
- latency compensation through parallel dry/wet and sidechain paths;
- device disconnect, default-route change and timestamp discontinuity;
- clock drift in both directions with FIFO bounds and no sample duplication;
- plug-in crash/hang in bridged mode and missed GPU deadline fallback;
- callback p50/p95/p99/max CPU time, xruns and queue drops at 48 kHz with 16,
  32, 64, 128 and 256-frame blocks;
- empirical loopback round-trip measurement kept separate from API-reported
  components. [OboeTester](https://github.com/google/oboe/blob/main/apps/OboeTester/docs/Usage.md)
  provides a useful correlation-based reference.

Physical gates are the Mac with the Zen Quadro and microphone on channel 3,
the Dell Windows laptop under both WASAPI modes and—after licensing—ASIO, one
real iPhone and one real Android device. Wireless/Bluetooth and CarPlay/Android
Auto are latency/route-change tests, not live-monitoring acceptance paths.

## Dependency and licensing policy

| Category | Current recommendation |
| --- | --- |
| Platform I/O | Native Core Audio/RemoteIO, WASAPI, and Oboe/AAudio in `zcore`; ASIO gated by license. |
| Graph | Own small compiled `zdsp` graph so SingZ controls clocks, lifetime, mobile footprint and IPC boundaries. |
| Portable SIMD | Evaluate Highway after scalar parity and block-size benchmarks. |
| Apple SIMD/FFT | Evaluate Accelerate/vDSP as a platform backend. |
| Neural real-time block | Evaluate BSD-licensed RTNeural per model and target. |
| Plug-in adapters | Own the stable `zdsp` contract; later evaluate iPlug2/JUCE only with a licensing and footprint decision. |
| Reference only | Ardour, JACK, Tracktion, Carla, MOD Host and Guitarix patterns; do not copy copyleft code. |
| GPU | Experimental optional backend with an explicit latency budget and CPU fallback. |

Every third-party candidate needs a transitive license, ABI, mobile-size,
determinism and real-time-safety audit. A permissive top-level license does not
prove that every optional module, model or plug-in SDK is distributable under
the same terms.

## Resulting changes to the roadmap

The phased graph plan should preserve these decisions:

1. `zcore` first exposes truthful per-OS device clocks, buffers, route
   generations and latency components.
2. `zdsp` begins as a serial immutable compiled CPU graph with a reusable
   preallocated arena and explicit snapshot retirement.
3. Device-native format adaptation occurs once at graph edges; fixed-quantum
   and thread/clock adapters are explicit latency-bearing nodes.
4. CPU SIMD is optimized and measured before parallel workers or GPU work.
5. Parallel stages, bridged plug-ins and GPU nodes are independent later
   capabilities, each with a fallback and observable latency/deadline policy.
6. Loopback measurement and deadline telemetry ship with the engine rather
   than being postponed until performance problems appear.
