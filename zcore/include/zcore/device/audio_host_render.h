#pragma once

#include <cstdint>

namespace singz {

inline constexpr uint32_t kAudioHostMaxChannels = 64;
inline constexpr uint32_t kAudioHostMaxFrames = 8192;

enum class AudioHostAccessMode : uint32_t {
  Shared,
  Exclusive,
};

// Negotiated callback facts live with the callback contract rather than the
// control-only inventory API, so RT leaves never need owning/string headers.
struct AudioHostFormat {
  double sampleRate{0.0};
  uint32_t maximumFrames{0};
  uint32_t nominalBufferFrames{0};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  bool float32Planar{true};
  bool outputClockMaster{true};
  AudioHostAccessMode accessMode{AudioHostAccessMode::Shared};
};

constexpr uint64_t advanceAudioHostFrame(uint64_t value,
                                         uint32_t frames) noexcept {
  return value > UINT64_MAX - frames ? UINT64_MAX : value + frames;
}

constexpr bool validAudioHostSampleFrame(double value,
                                         uint32_t frames) noexcept {
  constexpr double kTwoTo64 = 18446744073709551616.0;
  return value >= 0.0 && value < kTwoTo64 &&
         static_cast<uint64_t>(value) <= UINT64_MAX - frames;
}

enum AudioHostDiscontinuity : uint32_t {
  AudioHostDiscontinuityNone = 0,
  AudioHostDiscontinuityStart = 1u << 0,
  AudioHostDiscontinuityRouteChanged = 1u << 1,
  AudioHostDiscontinuityXRun = 1u << 2,
  AudioHostDiscontinuityDeviceLost = 1u << 3,
  AudioHostDiscontinuityTimestampQualityChanged = 1u << 4,
  AudioHostDiscontinuityClockReanchored = 1u << 5,
  AudioHostDiscontinuitySequenceGap = 1u << 6,
};

struct AudioHostRenderBlock {
  const float* const* input{nullptr};
  float* const* output{nullptr};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  uint32_t frames{0};
  uint32_t maximumFrames{0};
  double sampleRate{0.0};
  uint64_t clockDomain{0};
  uint64_t routeGeneration{0};
  uint64_t streamGeneration{0};
  uint64_t callbackSequence{0};
  uint64_t inputSourceFrame{0};
  uint64_t inputSampleHostTimeNs{0};
  bool inputTimestampValid{false};
  bool inputTimestampHardware{false};
  uint64_t outputFrame{0};
  uint64_t outputHostTimeNs{0};
  uint64_t callbackHostTimeNs{0};
  uint32_t discontinuity{AudioHostDiscontinuityNone};
  bool outputClockMaster{true};
};

using AudioHostRender = bool (*)(void*, const AudioHostRenderBlock&) noexcept;

}  // namespace singz
