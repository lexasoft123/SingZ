#pragma once

#include "zdsp/clock.h"

namespace zdsp {

// Phase 0B supports one canonical render format. New formats require an
// explicit prepare-time negotiation; a process callback never guesses.
enum class SampleFormat : uint32_t { Float32Planar = 1 };
enum class AudioChannelLayout : uint32_t { Mono = 1, Stereo = 2, Discrete = 3 };
enum class AudioChannelRole : uint32_t {
  Mono = 1,
  Left = 2,
  Right = 3,
  Center = 4,
  Lfe = 5,
  LeftSurround = 6,
  RightSurround = 7,
  Discrete = 8,
};

// Mono and stereo use their canonical role order and must leave channelRoles
// null. Discrete buses provide exactly channelCount roles; roles describe
// identity only and never imply interleaving or a speaker-remap operation.
struct AudioBusDescriptor {
  uint32_t channelCount;
  SampleFormat sampleFormat;
  AudioChannelLayout layout;
  const AudioChannelRole* channelRoles;
};

struct ConstAudioBusView {
  const float* const* channels;
  uint32_t channelCount;
  FrameCount frames;
  FrameCount capacityFrames;
  const CaptureTime* capture;
};

struct MutableAudioBusView {
  float* const* channels;
  uint32_t channelCount;
  FrameCount frames;
  FrameCount capacityFrames;
};

constexpr bool isValid(const ConstAudioBusView& bus) noexcept {
  return bus.frames.value <= bus.capacityFrames.value &&
         (bus.frames.value == 0 || (bus.channels != nullptr && bus.channelCount != 0));
}
constexpr bool isValid(const MutableAudioBusView& bus) noexcept {
  return bus.frames.value <= bus.capacityFrames.value &&
         (bus.frames.value == 0 || (bus.channels != nullptr && bus.channelCount != 0));
}

[[nodiscard]] ZDSP_INTERNAL_API bool isValid(
    const AudioBusDescriptor& descriptor) noexcept;

}  // namespace zdsp
