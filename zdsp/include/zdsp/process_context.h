#pragma once

#include "zdsp/events.h"

namespace zdsp {

enum RenderTimeFlags : uint32_t {
  RenderTimeNone = 0,
  RenderTimeHostValid = 1u << 0,
  RenderTimeDiscontinuous = 1u << 1,
};
struct RenderTime {
  ClockDomainId clockDomain;
  StreamGeneration streamGeneration;
  FramePosition graphFrame;
  HostTimeNs renderHostTime;
  HostTimeNs callbackHostTime;
  uint32_t flags;
};
enum TransportValidFields : uint64_t {
  TransportValidProjectSamples = 1ull << 0,
  TransportValidContinuousSamples = 1ull << 1,
  TransportValidTempo = 1ull << 2,
  TransportValidMusicPosition = 1ull << 3,
  TransportValidCycleRange = 1ull << 4,
  TransportValidTimeSignature = 1ull << 5,
};
enum TransportStateFlags : uint32_t {
  TransportStateNone = 0,
  TransportStatePlaying = 1u << 0,
  TransportStateRecording = 1u << 1,
  TransportStateCycling = 1u << 2,
};
struct TransportContext {
  uint64_t validFields;
  uint32_t stateFlags;
  // Sample positions are signed so valid negative pre-roll needs no sentinel.
  int64_t projectTimeSamples;
  int64_t continuousTimeSamples;
  // When their validity bits are set: tempo is finite and positive; musical
  // positions are finite; cycleEndMusic is greater than cycleStartMusic; and
  // a time signature has a positive numerator and power-of-two denominator.
  double tempo;
  double projectTimeMusic;
  double barPositionMusic;
  double cycleStartMusic;
  double cycleEndMusic;
  int32_t timeSignatureNumerator;
  int32_t timeSignatureDenominator;
};
struct ScratchView { uint8_t* data; uint32_t size; };
struct ProcessContext {
  uint32_t interfaceVersion;
  uint32_t structSize;
  RenderTime time;
  const TransportContext* transport;
  SampleRateHz sampleRate;
  FrameCount frames;
  const ParameterEvent* parameters;
  uint32_t parameterCount;
  const MusicalEvent* events;
  uint32_t eventCount;
  ScratchView scratch;
  Discontinuity discontinuity;
};
inline constexpr uint32_t kProcessContextV1RequiredSize =
    static_cast<uint32_t>(offsetof(ProcessContext, discontinuity) +
                          sizeof(decltype(ProcessContext::discontinuity)));
[[nodiscard]] ZDSP_INTERNAL_API Status validateProcessContext(
    const ProcessContext& context) noexcept;

}  // namespace zdsp
