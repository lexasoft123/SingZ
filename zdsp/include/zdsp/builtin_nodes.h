#pragma once

#include "zdsp/processor.h"
#include "zdsp/realtime_arena.h"

namespace zdsp {

enum class BuiltinNodeKind : uint32_t {
  Gain = 1,
  ChannelMap,
  Mix,
  DelayCompensation,
  PeakRms,
  Oscillator,
  Tap,
  SafetyLimiter,
};

enum class OscillatorWaveform : uint32_t { Sine = 0, Saw = 1 };

struct BuiltinNodeConfig {
  BuiltinNodeKind kind;
  NodeId node;
  uint32_t inputChannels;
  uint32_t outputChannels;
  uint32_t inputBusCount;
  // Kind-specific primary value: finite gain; limiter threshold in (0, 1];
  // or oscillator frequency >= 0 and <= Nyquist at prepare time.
  float value0;
  // Kind-specific secondary value. Oscillator amplitude is finite in [0, 1].
  // It must remain finite for every kind even when currently unused.
  float value1;
  uint32_t frames;
  OscillatorWaveform waveform;
  const float* channelMatrix;
  uint32_t tapCapacityFrames;
};

struct MeterReading {
  float peak;
  float rms;
  uint64_t frames;
};

[[nodiscard]] ZDSP_INTERNAL_API size_t builtinStateBytes(
    const BuiltinNodeConfig& config) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API size_t builtinPreparedBytes(
    const BuiltinNodeConfig& config, FrameCount maximumBlockFrames) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ProcessorHandle createBuiltinProcessor(
    const BuiltinNodeConfig& config, MutableByteView stateStorage) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API MeterReading builtinMeter(
    const ProcessorHandle& processor) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API uint32_t builtinTapFrames(
    const ProcessorHandle& processor) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API uint32_t builtinTapSnapshot(
    const ProcessorHandle& processor, float* destination,
    uint32_t capacityFrames) noexcept;
// Test-only synchronization point after a reader has validated a physical
// telemetry slot and before copying its payload. Product readers use the
// overload above; this helper exists solely to deterministically prove slot
// reuse/retry behavior under sanitizers.
using BuiltinTelemetryReadHook = void (*)(void*) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API uint32_t builtinTapSnapshotTestOnly(
    const ProcessorHandle& processor, float* destination,
    uint32_t capacityFrames, BuiltinTelemetryReadHook hook,
    void* hookContext) noexcept;

inline constexpr ParameterId kGainParameter{1};
inline constexpr ParameterId kOscillatorFrequencyParameter{1};
inline constexpr ParameterId kLimiterThresholdParameter{1};

}  // namespace zdsp
