#pragma once

#include "zdsp/audio_bus.h"
#include "zdsp/process_context.h"

namespace zdsp {

inline constexpr uint32_t kProcessorInterfaceVersion = 1;
inline constexpr uint32_t kProcessContextInterfaceVersion = 1;
inline constexpr uint32_t kMaximumChannelsPerBus = 64;
inline constexpr uint32_t kMaximumBusesPerProcessor = 16;
inline constexpr uint32_t kMaximumEventsPerBlock = 256;
enum class TailKind : uint32_t { None = 0, Finite, Infinite };
struct TailInfo { TailKind kind; FrameLength frames; };
struct PrepareSpec {
  uint32_t interfaceVersion;
  uint32_t structSize;
  SampleRateHz sampleRate;
  FrameCount maximumBlockFrames;
  uint32_t inputBusCount;
  uint32_t outputBusCount;
  const AudioBusDescriptor* inputBuses;
  const AudioBusDescriptor* outputBuses;
};
inline constexpr uint32_t kPrepareSpecV1RequiredSize =
    static_cast<uint32_t>(offsetof(PrepareSpec, outputBuses) +
                          sizeof(decltype(PrepareSpec::outputBuses)));
struct PreparedStorage { void* data; size_t size; size_t alignment; };

using ProcessorPrepareFn = Status (*)(void*, const PrepareSpec*,
                                      const PreparedStorage*) noexcept;
using ProcessorResetFn = void (*)(void*, Discontinuity) noexcept;
using ProcessorProcessFn = void (*)(void*, const ProcessContext*,
                                    const ConstAudioBusView*, uint32_t,
                                    const MutableAudioBusView*, uint32_t) noexcept;
using ProcessorLatencyFn = LatencyFrames (*)(const void*) noexcept;
using ProcessorTailFn = TailInfo (*)(const void*) noexcept;
using ProcessorDeactivateFn = Status (*)(void*) noexcept;
using ProcessorDestroyFn = Status (*)(void*) noexcept;
// Optional append-only V2 hook. A processor batches samples it contained
// internally and the runner consumes the count once after each process call.
using ProcessorConsumeNonFiniteFn = uint32_t (*)(void*) noexcept;

// This is a same-toolchain, statically linked C++20 interface. POD and an
// opaque state keep product components decoupled, but this vtable is not a
// cross-compiler/shared-library/plugin C ABI. Such boundaries require the
// future C adapter described in ADR 0001.
struct ProcessorVTable {
  uint32_t interfaceVersion;
  uint32_t structSize;
  ProcessorPrepareFn prepare;
  ProcessorResetFn reset;
  ProcessorProcessFn process;
  ProcessorLatencyFn latency;
  ProcessorTailFn tail;
  ProcessorDeactivateFn deactivate;
  ProcessorDestroyFn destroy;
  ProcessorConsumeNonFiniteFn consumeNonFinite{nullptr};
};
inline constexpr uint32_t kProcessorVTableV1RequiredSize =
    static_cast<uint32_t>(offsetof(ProcessorVTable, destroy) +
                          sizeof(decltype(ProcessorVTable::destroy)));
inline constexpr uint32_t kProcessorVTableV2RequiredSize =
    static_cast<uint32_t>(offsetof(ProcessorVTable, consumeNonFinite) +
                          sizeof(decltype(ProcessorVTable::consumeNonFinite)));
struct ProcessorHandle { void* state; const ProcessorVTable* functions; };
[[nodiscard]] ZDSP_INTERNAL_API Status validateProcessor(
    const ProcessorHandle& processor) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API Status validatePrepareSpec(
    const PrepareSpec& spec) noexcept;
// Control-thread lifecycle: prepare activates; deactivate quiesces external
// work; destroy tears down the opaque state. Storage reclamation remains the
// caller's responsibility and happens only after destroy returns.
[[nodiscard]] ZDSP_INTERNAL_API Status deactivateProcessor(
    const ProcessorHandle& processor) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API Status destroyProcessor(
    ProcessorHandle* processor) noexcept;

}  // namespace zdsp
