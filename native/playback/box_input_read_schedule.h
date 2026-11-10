#pragma once
#include <loopz/render_schedule.hpp>
#include <loopz/timeline.hpp>

namespace singz {
// Fixed private analysis clock, independent of delivery/inference wakeup
// jitter. The base history lookback is 2048 frames (~43 ms). Up to another 2048
// frames of backlog may be recovered, in batches of at most four blocks. This
// is a consumer scheduling budget, not physical input or total pitch latency.
class BoxInputReadSchedule final {
public:
  static constexpr uint32_t sampleRate = 48000, blockFrames = 256;
  static constexpr uint32_t historyLookbackFrames = 2048,
                            maximumCatchupFrames = 2048;
  struct Batch {
    loopz::ScheduledRender plan;
    bool discontinuity() const noexcept {
      return plan.reanchored || plan.skippedFrames != 0;
    }
    uint64_t sampleHostTimeNs(uint32_t index) const noexcept {
      const uint64_t frame = plan.firstFrame + uint64_t(index) * blockFrames;
      return frame >= historyLookbackFrames
                 ? loopz::frameNs(frame - historyLookbackFrames, sampleRate)
                 : 0;
    }
  };
  Batch step(uint64_t nowNs) noexcept { return {schedule_.step(nowNs)}; }

private:
  loopz::RenderSchedule schedule_{
      {sampleRate, blockFrames, 0, maximumCatchupFrames}};
};
} // namespace singz
