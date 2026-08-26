#pragma once

#include "zdsp/processor.h"

namespace zdsp {

inline constexpr ParameterId kPrototypeGainParameter{1};
struct PrototypeMeterResult {
  float peak;
  float rms;
  FramePosition endFrame;
  uint32_t samples;
  uint32_t resetCount;
};
struct PrototypeGainMeterConfig { NodeId node; float initialGain; };
struct PrototypeGainMeterState {
  NodeId node;
  SampleRateHz sampleRate;
  FrameCount maximumBlockFrames;
  uint32_t channelCount;
  float currentGain;
  float targetGain;
  float gainStep;
  uint32_t rampRemaining;
  PrototypeMeterResult meter;
  uint32_t prepared;
  uint32_t active;
  uint32_t destroyed;
};
[[nodiscard]] ZDSP_INTERNAL_API size_t prototypeGainMeterStorageSize() noexcept;
[[nodiscard]] ZDSP_INTERNAL_API size_t prototypeGainMeterStorageAlignment() noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ProcessorHandle makePrototypeGainMeter(
    const PrototypeGainMeterConfig& config,
    const PreparedStorage& storage) noexcept;
// Test-support only and same-thread by contract. Returning by value prevents a
// control/UI consumer from retaining a pointer into mutable render state.
[[nodiscard]] ZDSP_INTERNAL_API PrototypeMeterResult prototypeMeter(
    const ProcessorHandle& processor) noexcept;

// Deliberately tiny Phase 0B fake host, not the Phase 1 production DAG runner.
struct PrototypeFakeHost {
  ProcessorHandle processor;
  SampleRateHz sampleRate;
  FrameCount maximumBlockFrames;
  uint32_t inputChannelCount;
  uint32_t outputChannelCount;
  FramePosition nextFrame;
  ClockDomainId clockDomain;
  StreamGeneration streamGeneration;
  uint32_t active;
  uint32_t resetDispatchCount;
};
[[nodiscard]] ZDSP_INTERNAL_API Status preparePrototypeFakeHost(
    PrototypeFakeHost* host,
    ProcessorHandle processor,
    const PrepareSpec& spec) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API Status processPrototypeBlock(
    PrototypeFakeHost* host,
    const ConstAudioBusView& input,
    const MutableAudioBusView& output,
    const ParameterEvent* parameters,
    uint32_t parameterCount,
    Discontinuity discontinuity) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API Status destroyPrototypeFakeHost(
    PrototypeFakeHost* host) noexcept;

}  // namespace zdsp
