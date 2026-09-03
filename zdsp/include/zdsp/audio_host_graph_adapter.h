#pragma once

#include <atomic>
#include <cstdint>

#include <zcore/device/audio_host_render.h>
#include <zdsp/clock.h>
#include <zdsp/process_context.h>

namespace zdsp {
struct GraphRunner;

static_assert(std::atomic<uint32_t>::is_always_lock_free,
              "The audio-host adapter requires native 32-bit atomic telemetry");

// A callback may be split only at transport boundaries. The hard limit is
// proven by the AudioHost callback bound and the rule that every admitted
// slice contains at least one frame: even a one-frame loop cannot exceed it.
inline constexpr uint32_t kAudioHostMaximumTransportSlices =
    singz::kAudioHostMaxFrames;

struct AudioHostTransportSlice {
  TransportContext transport{};
  FrameCount frames{};
  Discontinuity discontinuity{DiscontinuityReason::None, DiscontinuityFlagNone};
};

// Callback-domain transport slices supplied by the owning engine/session.
// For one `(host block, offset, remaining)` query the provider returns the
// transport at that exact offset and a nonzero frame count no larger than
// remaining. A boundary discontinuity belongs to the returned first frame.
// The provider and context must remain alive until AudioHost::stop has closed
// callback admission and drained the callback. Implementations must be
// bounded, lock-free, allocation-free and noexcept.
struct AudioHostTransportSliceProvider {
  bool (*slice)(void *, const singz::AudioHostRenderBlock &, uint32_t, uint32_t,
                AudioHostTransportSlice *) noexcept {nullptr};
  void *context{nullptr};
};

struct AudioHostGraphAdapter {
  GraphRunner *runner{nullptr};
  AudioHostTransportSliceProvider transport{};
  std::atomic<uint32_t> renderFailures{0};
  std::atomic<uint32_t> lastStatusCode{0};
  /* Status carries a `detail` naming WHICH check failed. The codes alone
     collapse a dozen different refusals into "InvalidArgument", so keeping
     only the code makes a graph that will not render look exactly like an
     audio-device fault. */
  std::atomic<uint32_t> lastStatusDetail{0};
};

// Normalizes hardware callback flags into the one typed reset boundary that
// processors observe. When host and transport boundaries coincide, the
// coalescer chooses exactly one reason in this priority order:
// DeviceLost > SourceFrameOverflow > RouteGenerationChanged >
// StreamGenerationChanged > ClockReanchored > SequenceGap >
// SampleRateChanged > TimestampQualityChanged > SourceSeek > SourceLoop.
// The higher-priority boundary owns the flags; every non-None result is
// guaranteed to carry ResetState. Ties preserve `left`.
Discontinuity mapAudioHostDiscontinuity(uint32_t flags) noexcept;
Discontinuity coalesceAudioHostDiscontinuity(Discontinuity left,
                                             Discontinuity right) noexcept;

bool renderAudioHostGraph(void *context,
                          const singz::AudioHostRenderBlock &block) noexcept;
void mapAudioHostProcessContext(const singz::AudioHostRenderBlock &block,
                                ProcessContext *process,
                                CaptureTime *capture) noexcept;

} // namespace zdsp
