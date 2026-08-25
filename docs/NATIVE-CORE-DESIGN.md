# `zcore` and `zdsp` native design

Status: proposed implementation standard

Last reviewed: 2026-08-26

This document defines the language profile, component boundaries, design
patterns, target layout and dependency policy for the native SingZ audio
foundation. It complements the system-level
[DSP graph plan](DSP-GRAPH-PLAN.md) and the
[implementation research](DSP-IMPLEMENTATION-RESEARCH.md).

The names `zcore` and `zdsp` describe two source packages, not two monolithic
libraries. Each package produces narrow CMake targets so an audio callback does
not inherit codecs, ONNX Runtime, plug-in SDKs or product bindings it never
uses.

## Why the current layout will not scale

PR #13 correctly proved one reusable implementation across four operating
systems, but its temporary home under `mobile/native/core` now mixes concerns:

- device capture, clocks, wake primitives and channel conversion;
- live and offline analysis, melody, beats and resampling;
- WAV/FLAC media I/O;
- ONNX-backed inference and stem splitting;
- a native CLI and Android JNI binding;
- platform implementations and test injection.

The host CMake build creates one `singz_core` and publicly links FLAC and
threads. Android manually repeats a different source list and enables
exceptions/RTTI on the whole shared library because ONNX Runtime needs them.
iOS consumes a generated copy through a broad pod glob. C++17 is specified in
three places even though the generated React Native Xcode project already uses
C++20. Adding one source or changing one dependency can therefore produce
different native products on host, Android and iOS.

The good existing boundary should remain: `AudioInputBackend` owns control-side
open/start/stop while the callback pushes through a plain function pointer.
The existing ring also correctly requires lock-free 32-bit atomics because
SingZ still ships armeabi-v7a, where 64-bit atomics may use a lock. The redesign
generalizes these decisions instead of replacing them for novelty.

## Package and dependency boundaries

```mermaid
flowchart TD
  B[zcore_base] --> A[zcore_audio]
  A --> D[zcore_device]
  B --> M[zcore_media]

  A --> API[zdsp_api]
  API --> RT[zdsp_runtime]
  API --> N[zdsp_nodes]
  API --> AN[zdsp_analysis]
  AN --> ML[zdsp_ml]
  API --> PL[zdsp_plugins]

  D --> H[product AudioHost coordinator]
  RT --> H
  M --> APP[app/offline tools]
  AN --> APP
  ML --> APP
  PL --> H
```

Rules:

- `zcore_base` contains status/result, strong units, bounded utility types and
  platform/compiler definitions. It has no audio device, codec or framework
  dependency.
- `zcore_audio` contains audio bus views, formats, clocks/timestamps, channel
  layouts, SPSC transport and bounded diagnostics.
- `zcore_device` contains `AudioHost`, inventory/session contracts and the
  selected platform backend targets. It does not know about `zdsp`; the product
  coordinator installs a render function plus opaque context.
- `zcore_media` contains WAV/FLAC and later streaming decode. It never appears
  in the live graph's transitive link interface.
- `zdsp_api` contains processor, graph-description, parameter/event and
  latency contracts.
- `zdsp_runtime` contains graph compilation, immutable snapshots, the real-time
  arena, buffer planner, runner and retirement.
- `zdsp_nodes` contains prepared built-in real-time processors.
- `zdsp_analysis` contains live taps and offline music-analysis algorithms.
- `zdsp_ml` contains ONNX/other inference adapters. It is not linked into a
  process that only needs device I/O and ordinary DSP.
- `zdsp_plugins` contains format-neutral hosting plus separately gated VST3,
  AU and CLAP adapters.
- UI, Electron, React Native, JNI, Swift/Objective-C and Java/Kotlin types stay
  in product bindings, never in public `zcore` or `zdsp` headers.

`zcore` never depends on `zdsp`. `zdsp` links only the narrow `zcore_base` and
`zcore_audio` targets it uses. No production target links an umbrella “all
native features” library.

## Repository layout

```text
CMakeLists.txt                    # native superbuild; options and add_subdirectory only
CMakePresets.json                 # checked-in host/CI/dev/sanitizer presets
cmake/
  SingZCompilerWarnings.cmake
  SingZRealtimeTarget.cmake
  SingZSanitizers.cmake
  SingZThirdParty.cmake
third_party/native/
  CMakeLists.txt                  # pinned wrapper targets and license inventory
  flac/

zcore/
  CMakeLists.txt
  include/zcore/
    base/                         # Result, strong units, bounded IDs
    audio/                        # AudioBusView, format, clock, channel layout
    device/                       # AudioHost and route/session contracts
    media/                        # non-RT codec/source contracts
  src/
    base/
    audio/
    device/
    media/
  platform/
    macos/                        # AUHAL host and Core Audio inventory
    windows/                      # WASAPI; ASIO remains a separate target
    ios/                          # RemoteIO and AVAudioSession adapter
    android/                      # Oboe/AAudio and route policy
  tests/

zdsp/
  CMakeLists.txt
  include/zdsp/
    processor.h
    process_context.h
    graph_description.h
    parameter_event.h
  src/
    graph/                        # validation, compiler, latency and buffer plans
    runtime/                      # runner, arena, snapshots, epochs, queues
  nodes/
    basic/                        # gain, mix, channel map, delay, meter
    filters/
    dynamics/
    time/                         # resample/stretch/oversampling adapters
    analysis/
  backends/
    scalar/
    accelerate/                   # Apple vDSP implementation
    highway/                      # optional portable SIMD implementation
  offline/                        # melody, beats, stem analysis/inference adapters
  plugins/
    api/
    vst3/
    au/
    clap/
    bridge/
  tests/
  benchmarks/

tools/native/                     # singz-analyze and future graph renderer
src/main/native/                  # Electron/product host binding
mobile/native/bindings/android/  # package-specific JNI only
mobile/ios/SingzCore/             # product pod/Objective-C++ wrappers only
tests/native/integration/         # cross-package and device-fake tests
```

Files are grouped by responsibility, then platform, rather than accumulating
suffixes in one directory. Platform implementations remain separate classes
and separate files. Public headers mirror their installed include path; private
headers stay beside implementation and cannot be included by consumers.

The authoritative library definitions live in the root CMake build. Android
uses `add_subdirectory()` and links the same targets instead of repeating
source lists. During the transition, the iOS materialized pod copy remains a
generated packaging adapter; the durable goal is a `zcore`/`zdsp`-owned pod or
XCFramework that consumes those component definitions, never a second editable
source tree.

## CMake policy

Use target properties throughout:

```cmake
add_library(zcore_audio STATIC)
add_library(SingZ::zcore_audio ALIAS zcore_audio)
target_compile_features(zcore_audio PUBLIC cxx_std_20)
target_include_directories(zcore_audio
  PUBLIC "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>")
target_link_libraries(zcore_audio PUBLIC SingZ::zcore_base)

add_library(zdsp_runtime STATIC)
add_library(SingZ::zdsp_runtime ALIAS zdsp_runtime)
target_compile_features(zdsp_runtime PUBLIC cxx_std_20)
target_link_libraries(zdsp_runtime
  PUBLIC SingZ::zdsp_api
  PRIVATE SingZ::zcore_audio)
singz_configure_realtime_target(zdsp_runtime)
```

CMake's official guidance recommends
[`target_compile_features`](https://cmake.org/cmake/help/latest/guide/tutorial/In-Depth%20CMake%20Target%20Commands.html)
instead of a repository-wide language-standard variable. `PUBLIC`, `PRIVATE`
and `INTERFACE` usage requirements must reflect actual header exposure. A
third-party dependency is `PRIVATE` unless a public header unavoidably names
its type; public native headers should avoid doing so.

Additional rules:

- List first-party and vendored source files explicitly. CMake itself
  [discourages source globs](https://cmake.org/cmake/help/latest/command/file.html#filesystem)
  because generators may miss additions and every build pays a rescan cost.
- Use checked-in [CMake presets](https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html)
  for macOS arm64/x64, Windows x64, Android ABIs, sanitizers and benchmarks.
- Build options select targets/backends, not `#ifdef` forests inside portable
  implementation. OS checks belong primarily in platform CMake files.
- Export namespaced targets; never expose raw include/link flags to apps.
- Default symbol visibility is hidden. Export only the narrow C or C++ API
  required by the product binding.
- Do not download dependencies during ordinary configure/build. Vendor small
  source dependencies or fetch them in a separate pinned bootstrap step with
  checksums, notices and an offline cache.
- Keep compiler warnings and hardening target-scoped. Third-party code compiles
  under wrapper targets without inheriting SingZ warning-as-error flags.
- `RelWithDebInfo` is the profiling build. Release may enable measured IPO/LTO;
  debug/sanitizer builds are correctness tools, never latency evidence.

## Language baseline: C++20 with two execution profiles

C++20 is the minimum for new `zcore`/`zdsp` APIs after toolchain gates pass on
MSVC, Apple Clang, Android NDK 27 and the armeabi-v7a build. Do not require
C++23 yet. The migration first changes target declarations and CI, then adopts
features; it does not mix a language bump with algorithm changes.

Useful zero-cost C++20 features include:

- `std::span` for callback-scoped non-owning audio/control views;
- `std::bit_cast` and `std::endian` for explicit representation work;
- `constexpr`/`consteval` for validated tables and descriptors prepared at
  compile time;
- concepts for constraining internal kernel templates;
- `[[nodiscard]]`, `[[maybe_unused]]` and scoped enums for safer contracts;
- designated initialization only where compiler parity and readability are
  proven.

Do not expose `std::jthread`, `std::stop_token` or `atomic::wait` in portable
contracts. The pinned NDK 27 libc++ hides parts of that API behind experimental
feature flags. A small `zcore` control-thread/cancellation abstraction uses the
portable `std::thread` plus an atomic stop flag and platform wake primitive;
where a standard facility is available it may be an internal implementation
detail. None of these mechanisms is callback synchronization.

The [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines.html)
explicitly note that dynamically allocating standard containers are unsuitable
for some hard-real-time work and that hard-real-time environments may require
systematic status returns instead of exceptions. SingZ therefore has two
profiles:

| Feature | Control, build, scan and offline threads | Real-time callback/runtime |
| --- | --- | --- |
| RAII, `unique_ptr`, `vector`, `string` | Preferred | Existing prepared storage may be viewed; no mutation that can allocate or destroy |
| Exceptions and RTTI | Allowed inside isolated adapters such as ORT; catch at boundary | Disabled for `zdsp_runtime` and built-in RT node targets |
| `shared_ptr` | Allowed when ownership genuinely is shared | Never acquired/released; final release and atomic shared pointers can lock/destroy |
| `std::function` | Allowed for ordinary callbacks | No; use function pointer plus opaque context or fixed-capacity callable proven allocation-free |
| Coroutines/futures | Allowed where useful off RT | Forbidden |
| Project control-thread/stop abstraction | Ordinary lifecycle; standard facilities may be used behind a feature gate | Never start/stop/join in callback |
| Mutex, semaphore, condition variable or blocking wait | Allowed where supported | Forbidden; only specified SPSC atomics and the separately reviewed bounded parallel spin policy |
| `pmr` and arenas | Useful while compiling snapshots | Render arena is already frozen; no allocation calls |
| ranges/algorithms | Preferred when clear and measured | Permitted only when generated work is bounded, allocation-free and benchmark-equivalent |
| filesystem, format, iostream, locale | Allowed | Forbidden |

Every function reachable from a device callback is `noexcept`. Preparation
returns a `[[nodiscard]] Result<T>`/`Status`; C++20 lacks `std::expected`, so
SingZ should own one small non-allocating result type rather than leak a large
utility dependency through public headers. Error strings are built off RT.

Do not globally enable `-ffast-math`, `/fp:fast` or `-march=native`. Fast-math
can invalidate NaN/Inf containment and reproducibility, and native ISA flags
produce binaries that fail on older fleet CPUs. A measured kernel may opt into
FMA/relaxed math locally with scalar parity and error bounds. Shipping x64
keeps a conservative baseline and uses runtime dispatch; arm64 may assume NEON.

## API and design patterns

### Strong units and views

Do not pass unrelated time quantities as naked `double`/`uint64_t`. Use small
trivial wrappers such as `SampleRateHz`, `FrameCount`, `FramePosition`,
`HostTimeNs`, `LatencyFrames` and `RouteGeneration`. Conversions are explicit
and happen outside inner sample loops.

`AudioBusView` is non-owning and trivial: channel pointers, channel/frame
counts, stride/layout and capacity. Const input and mutable output are separate
types. A view never extends driver-buffer or arena-slot lifetime.

### Prepare/compile/process

Node factories and descriptive objects live on the control side. `prepare()`
creates durable state; the graph compiler lowers it into a data-oriented list:

```cpp
using RenderFn = void (*)(void* state, ProcessContext&) noexcept;

struct RenderOp {
  RenderFn render;
  void* state;
  BufferBinding inputs;
  BufferBinding outputs;
};
```

One indirect call per node per block is acceptable; virtual or branch-heavy
dispatch per sample is not. A virtual control-side `ProcessorFactory` may
prepare nodes, while the render plan holds function thunks and stable state
addresses. Do not use `dynamic_cast` or string lookup in the runner.

### Immutable snapshot plus epoch retirement

The control thread builds a complete snapshot, then publishes its pointer at a
block boundary. The render thread never edits topology. Handles are stable IDs
plus generations, not owning pointers. Old snapshots and node destructors are
retired off RT after every relevant render worker acknowledges the epoch.

RAII remains the right control-plane ownership mechanism, but resource lifetime
and audible graph lifetime are explicit and separate. A retained snapshot must
not keep registration, MIDI or file side effects alive accidentally.

### Strategy without framework ownership

Scalar, Accelerate and Highway kernels implement a narrow internal strategy
interface selected during preparation. Platform audio hosts implement the
`AudioHost` control contract. Plug-in formats implement `PluginFormat`.
None owns or subclasses the public graph runtime.

Avoid a service locator, global audio singleton or abstract factory forest.
The product composition root constructs the device backend, graph compiler,
runner and session coordinator explicitly. Tests inject those dependencies
through constructors/factories instead of production-wide test macros.

### ABI boundaries

Static C++ targets may share internal C++20 types when built by one toolchain.
Shared-library, plug-in, JNI/Swift and future bridge boundaries use a versioned
C ABI or their platform ABI with POD descriptors, explicit sizes and opaque
handles. Never expose STL containers, exceptions, allocators or C++ class
layout across those boundaries.

## Memory and cache policy

- The graph compiler computes buffer liveness, aligns slots and records the
  exact arena high-water mark. Runtime allocation is impossible by API.
- Prefer structure-of-arrays/planar samples for kernels and channel loops.
  Interleave only at a driver or plug-in boundary that requires it.
- Keep immutable coefficients adjacent; keep producer and consumer cursors on
  separate cache lines. Do not assume `hardware_destructive_interference_size`
  has one stable ABI value—use a reviewed project constant per target.
- Preserve the current lock-free 32-bit SPSC cursor rule while armv7 ships.
  Widen statistics off RT. Every RT atomic has an
  `is_always_lock_free` assertion for every supported ABI.
- Power-of-two queue capacity may replace modulo with a mask when measurement
  justifies the constraint. Correct bounded behavior matters more than that
  micro-optimization.
- Stack use per processor is bounded and audited; large scratch arrays come
  from prepared arena slices.
- Prefault/warm memory, dispatch tables, FFT plans, resamplers and plug-ins
  before device start. Flush denormals according to the platform policy.
- No reference counts, destructors or arbitrary user callbacks run from the
  device callback.

## Libraries

The default is a small standard-library core plus native platform APIs. Add a
dependency only when it beats a SingZ scalar reference on representative
hardware and its license, binary size, initialization and RT behavior are
known.

| Library/API | Target boundary and decision |
| --- | --- |
| Core Audio/AudioToolbox, WASAPI, Oboe/AAudio | Required platform implementations in separate `zcore_device_*` targets. Oboe is preferred over handwritten Android-version branching. |
| libFLAC | Retain, but only behind `zcore_media`; never a public/transitive dependency of device or graph runtime. |
| ONNX Runtime | Retain for `zdsp_ml`/offline analysis only. Its exception/RTTI requirement must not change compile flags for RT targets. |
| Apple Accelerate/vDSP | Preferred measured Apple SIMD/FFT backend; no extra distribution dependency. |
| [Google Highway](https://github.com/google/highway) | Optional portable SIMD backend. Runtime dispatch has minor first-call CPU detection, so update/warm the selected target before audio starts. Keep a scalar implementation. |
| Signalsmith Stretch | Evaluate the native C++ library as one prepared time/pitch node; pin version/license and retain phase-coherent whole-song-bus semantics. |
| PFFFT or another permissive FFT | Benchmark only if vDSP is unavailable or insufficient. Plans and scratch allocate off RT; do not expose its types. |
| Resampler library | Do not choose by quality marketing alone. Compare the existing resampler and permissive candidates for dynamic-ratio drift correction, small-block delay, CPU and reset/discontinuity behavior. |
| [VST3 SDK](https://github.com/steinbergmedia/vst3sdk/blob/master/LICENSE.txt) | The current SDK is MIT-licensed; pin an exact release in `zdsp_plugins_vst3`, preserve notices and follow separate VST trademark guidance. This does not change ASIO's separate licensing gate. |
| JUCE/Tracktion | Reference or separately licensed comparison only; neither defines SingZ's ABI or target graph. |
| SPSC queue/RT arena | Keep the small SingZ-owned implementations because their ownership, overflow and armv7 atomic contracts are product-specific and auditable. |
| [Google Benchmark](https://github.com/google/benchmark) | Development-only `zdsp_benchmarks` dependency. Use `DoNotOptimize`, repetitions/statistics and custom throughput/deadline counters; never link it into products. |

Avoid Boost-sized public dependencies, general-purpose job systems, hidden
allocators, automatic sample-format conversion and header-only libraries that
multiply compile time/code size across every node without measured benefit.

## Performance build and measurement policy

- Scalar correctness is authoritative. Each optimized kernel has parity,
  impulse, sweep and randomized tests before it can be selected.
- Benchmark 48 kHz blocks of 16, 32, 64, 128 and 256 frames, mono through the
  maximum practical bus layout. Report ns/frame/channel as well as percentage
  of the callback deadline.
- Benchmark cold preparation separately from warmed steady-state processing.
  No first-call dispatch, page fault or lazy initialization is allowed in the
  latter.
- Google Benchmark compares kernels; a fake-host deadline harness measures
  complete graphs and jitter; physical loopback/device tests measure the system.
  None substitutes for the others.
- Use compiler optimization reports, assembly inspection and hardware counters
  only after profiles identify a hot kernel. Measure copies and cache misses,
  not only arithmetic throughput.
- Fuse adjacent trivial built-ins only when automation, metering, bypass and
  serialization semantics remain identical.
- IPO/LTO and profile-guided optimization are opt-in release experiments with
  binary-size, startup and parity gates. Do not use benchmark-only flags in
  normal products.
- Sanitizers, debug iterators and thread instrumentation run separate presets.
  Their timing is never reported as product latency.
- Record performance baselines by CPU/device and fail only on statistically
  meaningful regressions; noisy shared CI is a correctness/build gate, while
  the Mac/Zen Quadro and Dell are controlled performance gates.

## Migration sequence

1. Move with history, establish the root superbuild and get identical tests on
   host, Android and iOS before changing behavior.
2. Raise component targets to C++20 and prove MSVC, Apple Clang, NDK arm64 and
   armv7 builds. Replace global standard flags with target features.
3. Split `zcore_base`, `zcore_audio`, `zcore_device` and `zcore_media`; keep a
   temporary `SingZ::zcore_legacy` compatibility target only for migration.
4. Create the format-neutral `zdsp_api` target and contracts without changing
   application playback.
5. Isolate current analysis/resampling in `zdsp_analysis` and ONNX/stem work in
   `zdsp_ml`, preserving outputs and tolerances; both may now depend on
   `zdsp_api`.
6. Make Android link the root targets rather than repeat source lists. Keep the
   iOS copy generated until a dedicated pod/XCFramework integration passes
   clean and stale-binary tests.
7. Add serial `zdsp_runtime`, then the smallest gain/meter nodes.
8. Add scalar-versus-platform benchmark targets and only then introduce vDSP,
   Highway or another optimized backend.
9. Delete the compatibility target and fail CI if a product pulls media, ML or
   plug-in SDK dependencies into the real-time runtime unintentionally.

Each split is link-map tested. “The app builds” is not enough: CI records the
targets and external libraries present in the desktop, iOS and Android audio
host artifacts so architectural dependency creep is visible.
