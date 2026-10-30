#pragma once

#include "zdsp/processor.h"

namespace zdsp {

// These limits make both control-domain validation and callback work bounded.
// A cue schedule is intended for short reference sounds such as metronome,
// count-in and rehearsal prompts, not for decoded song lanes.
inline constexpr uint32_t kMaximumScheduledCueSounds = 16;
inline constexpr uint32_t kMaximumScheduledCueEvents = 131072;
inline constexpr uint32_t kMaximumScheduledCueFramesPerSound = 262144;
inline constexpr uint32_t kMaximumScheduledCueTotalSoundFrames = 1048576;
inline constexpr uint32_t kMaximumScheduledCueOverlap = 32;
inline constexpr uint32_t kMaximumScheduledCueEventsPerRender = 256;
inline constexpr uint32_t kMaximumScheduledCueOneShots = 32;

// Control-domain view over one immutable mono sound. The enclosing session
// keeps samples alive until the processor is deactivated and destroyed.
struct ScheduledCueSoundView {
  const float *samples;
  uint32_t frameCount;
};

// Events are sorted by nondecreasing signed project sample position. Equal
// positions are allowed and mix sample-for-sample.
struct ScheduledCueEvent {
  int64_t projectTimeSamples;
  uint32_t soundIndex;
};

// The processor borrows both arrays and every sound sample array. Creation
// validates their complete bounded contents on the control thread. Callers
// must not mutate or release them during the processor lifetime.
struct ScheduledCueSourceConfig {
  NodeId node;
  const ScheduledCueEvent *events;
  uint32_t eventCount;
  const ScheduledCueSoundView *sounds;
  uint32_t soundCount;
  SampleRateHz sampleRate;
  // Maximum project-sample advance per rendered output sample accepted by
  // this prepared source. Playback rate is structural: callers rebuild when
  // it changes, which lets prepare prove the callback event-density bound.
  uint64_t maximumProjectRateQ32{kProjectRateOneQ32};
};

[[nodiscard]] ZDSP_INTERNAL_API size_t scheduledCueSourceStateBytes() noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ProcessorHandle
createScheduledCueSource(const ScheduledCueSourceConfig &config,
                         MutableByteView stateStorage) noexcept;

// Generation ownership remains the enclosing session's responsibility. This
// leaf accepts one already-validated sound index into a bounded SPSC mailbox;
// the render thread starts it at the next graph-block boundary and carries its
// tail across later blocks without allocation, locks or control-domain I/O.
struct ScheduledCueOneShotStatus {
  uint64_t enqueued{0};
  uint64_t started{0};
  uint64_t completed{0};
  uint32_t pending{0};
};

[[nodiscard]] ZDSP_INTERNAL_API bool
enqueueScheduledCueOneShot(const ProcessorHandle &processor,
                           uint32_t soundIndex) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ScheduledCueOneShotStatus
scheduledCueOneShotStatus(const ProcessorHandle &processor) noexcept;

} // namespace zdsp
