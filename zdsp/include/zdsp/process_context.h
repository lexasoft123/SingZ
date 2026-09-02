#pragma once

#include "zdsp/events.h"

namespace zdsp {

enum RenderTimeFlags : uint32_t {
  RenderTimeNone = 0,
  RenderTimeHostValid = 1u << 0,
  RenderTimeDiscontinuous = 1u << 1,
  RenderTimeHostHardware = 1u << 2,
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
  // Project samples advance by projectRateQ32 for each rendered output
  // sample. projectTimeSamples is the signed floor and
  // projectTimeFractionQ32 is its non-negative fractional remainder. The
  // append-only representation keeps negative pre-roll unambiguous and does
  // not require compiler-specific 128-bit integers.
  TransportValidProjectRateQ32 = 1ull << 6,
};
inline constexpr uint64_t kProjectRateOneQ32 = uint64_t{1} << 32;
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
  uint32_t projectTimeFractionQ32{0};
  uint64_t projectRateQ32{kProjectRateOneQ32};
};
inline constexpr uint32_t kTransportContextV1RequiredSize =
    static_cast<uint32_t>(offsetof(TransportContext, timeSignatureDenominator) +
                          sizeof(decltype(TransportContext::timeSignatureDenominator)));
inline constexpr uint32_t kTransportContextQ32RequiredSize =
    static_cast<uint32_t>(offsetof(TransportContext, projectRateQ32) +
                          sizeof(decltype(TransportContext::projectRateQ32)));

struct ProjectSamplePositionQ32 {
  int64_t samples;
  uint32_t fraction;
};

// Callback-safe position arithmetic shared by transport-aware sources and
// schedules. Rates are bounded by the product prepare contract, while this
// helper additionally fails closed on any representational overflow.
[[nodiscard]] constexpr bool projectSamplePositionAt(
    const TransportContext& transport, uint32_t outputOffset,
    ProjectSamplePositionQ32* result) noexcept {
  if (result == nullptr ||
      (transport.validFields & TransportValidProjectSamples) == 0)
    return false;
  const bool rateValid =
      (transport.validFields & TransportValidProjectRateQ32) != 0;
  const uint64_t rate = rateValid ? transport.projectRateQ32
                                  : kProjectRateOneQ32;
  const uint32_t fraction =
      rateValid ? transport.projectTimeFractionQ32 : 0u;
  if (rate == 0 ||
      (outputOffset != 0 &&
       rate > UINT64_MAX / static_cast<uint64_t>(outputOffset)))
    return false;
  const uint64_t delta = rate * static_cast<uint64_t>(outputOffset);
  const uint64_t fractional =
      static_cast<uint64_t>(fraction) + (delta & 0xffffffffu);
  const uint64_t whole = (delta >> 32) + (fractional >> 32);
  if (whole > static_cast<uint64_t>(INT64_MAX) ||
      transport.projectTimeSamples >
          INT64_MAX - static_cast<int64_t>(whole))
    return false;
  result->samples =
      transport.projectTimeSamples + static_cast<int64_t>(whole);
  result->fraction = static_cast<uint32_t>(fractional);
  return true;
}
struct ScratchView { uint8_t* data; uint32_t size; };
enum ProcessContextFlags : uint32_t {
  ProcessContextFlagNone = 0,
  // The host is draining already-created processor state after graph
  // replacement. Sources must not generate, and processors must not consume
  // automation/events or treat transport as running.
  ProcessContextFlagTailDrain = 1u << 0,
};
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
  uint32_t flags{ProcessContextFlagNone};
};
inline constexpr uint32_t kProcessContextV1RequiredSize =
    static_cast<uint32_t>(offsetof(ProcessContext, discontinuity) +
                          sizeof(decltype(ProcessContext::discontinuity)));
inline constexpr uint32_t kProcessContextV2RequiredSize =
    static_cast<uint32_t>(offsetof(ProcessContext, flags) +
                          sizeof(decltype(ProcessContext::flags)));
constexpr uint32_t processContextFlags(const ProcessContext& context) noexcept {
  return context.structSize >= kProcessContextV2RequiredSize
      ? context.flags : ProcessContextFlagNone;
}
[[nodiscard]] ZDSP_INTERNAL_API Status validateProcessContext(
    const ProcessContext& context) noexcept;

}  // namespace zdsp
