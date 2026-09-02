#pragma once

#include "zdsp/processor.h"

namespace zdsp {

inline constexpr uint32_t kMaximumScheduledGainWindows = 16384;
inline constexpr ParameterId kScheduledGainEnableParameter{7};

struct ScheduledGainWindow {
  int64_t startProjectTimeSamples;
  int64_t endProjectTimeSamples;
};

enum class ScheduledGainMode : uint32_t { Period = 0, Windows = 1 };

// Immutable frame-domain schedule borrowed from the prepared playback owner.
// Period alternates outside/inside every periodFrames. Windows must be sorted,
// disjoint project ranges whose end frame is excluded. A scalar enable may arm
// or disarm the schedule at a block boundary without changing the schedule or
// the singer's independent lane gain/mute/solo state.
struct ScheduledGainConfig {
  NodeId node;
  ScheduledGainMode mode;
  const ScheduledGainWindow *windows;
  uint32_t windowCount;
  int64_t periodFrames;
  float insideGain;
  float outsideGain;
  FrameCount rampFrames;
  bool enabled;
};

[[nodiscard]] ZDSP_INTERNAL_API size_t scheduledGainStateBytes() noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ProcessorHandle
createScheduledGain(const ScheduledGainConfig &config,
                    MutableByteView stateStorage) noexcept;

} // namespace zdsp
