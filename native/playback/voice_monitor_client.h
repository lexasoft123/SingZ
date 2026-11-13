#pragma once
#include "voice_monitor.h"
#include "voice_monitor_source.h"
#include "shared_audio_service.h"
#include <array>

namespace singz {
// SINGZ_MONITOR_CLIENT_RT_BEGIN
// Callback-owned reader/ramp; control only publishes target and reads meters.
struct CommonVoiceMonitorRender {
  const void* owner{}; // Control-only admission context.
  VoiceMonitorSource* source{};
  VoiceMonitorReader reader;
  std::array<float, kAudioHostMaxFrames> mono{};
  std::atomic<float> target{0}, peak{0}, rms{0};
  std::atomic<uint32_t> period{0}, hostPeriod{0}, silent{1}, feedbackRisk{0};
  uint32_t queueFrames{0}; // Source frames; zero requests the publication floor.
  float current{0}, destination{0}, step{0};
  uint32_t remaining{0};
  static bool render(void* context, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<CommonVoiceMonitorRender*>(context);
    if (!self.source || block.frames > self.mono.size() || block.frames > block.maximumFrames ||
        block.outputChannels > kAudioHostMaxChannels) return true;
    self.period.store(block.frames, std::memory_order_relaxed);
    const auto floor = self.source->queueFloor(block.sampleRate,
        std::max(block.frames, self.hostPeriod.load(std::memory_order_acquire)));
    self.source->render(block, self.mono.data(), static_cast<uint32_t>(self.mono.size()),
                        floor ? std::max(self.queueFrames, floor) : kVoiceMonitorHistoryFrames, self.reader);
    const auto next = self.target.load(std::memory_order_acquire);
    if (next != self.destination) {
      self.destination = next; self.remaining = kVoiceMonitorRampFrames;
      self.step = (next - self.current) / kVoiceMonitorRampFrames;
    }
    float peak = 0;
    double squares = 0;
    for (uint32_t frame = 0; frame < block.frames; ++frame) {
      if (self.remaining && --self.remaining == 0) self.current = self.destination;
      else if (self.remaining) self.current += self.step;
      const auto raw = self.mono[frame];
      const float input = std::isfinite(raw) ? flushVoiceMonitorDenormal(raw) : 0;
      peak = std::max(peak, std::abs(input));
      squares += double(input) * input;
      const double scaled = double(input) * self.current;
      // Contain overflows without a private limiter: the final master owns
      // the ceiling, so attenuation at master can recover hot voice levels.
      const float voice = std::isfinite(scaled) && std::abs(scaled) >= 0x1p-126 &&
          std::abs(scaled) <= 0x1.fffffep127 ? static_cast<float>(scaled) : 0;
      for (uint32_t ch = 0; ch < std::min(block.outputChannels, 2u); ++ch)
        if (voice != 0 && block.output && block.output[ch]) block.output[ch][frame] += voice;
    }
    self.silent.store(self.current == 0 && self.destination == 0, std::memory_order_release);
    self.peak.store(peak, std::memory_order_relaxed);
    self.rms.store(block.frames ? static_cast<float>(std::sqrt(squares / block.frames)) : 0,
                   std::memory_order_relaxed);
    return true;
  }
};
// SINGZ_MONITOR_CLIENT_RT_END

// Control-domain API; bridge serializes calls. Injected owners permit portable
// lifecycle tests with exactly the production callback and capture transport.
VoiceMonitorAvailability classifyCommonVoiceMonitorRoute(const AudioHostInventory&,
    const std::string& input, uint32_t channel, const std::string& output, bool permission);
class CommonVoiceMonitor final {
 public:
  CommonVoiceMonitor(SharedAudioService&, VoiceMonitorCapture&);
  ~CommonVoiceMonitor();
  VoiceMonitorAvailability availability(const std::string&, uint32_t, bool permission) const;
  VoiceMonitorResult begin(const std::string&, uint32_t, bool permission, float gainDb,
                           uint64_t generation, uint32_t queueFrames = 0);
  bool setGain(float) noexcept;
  VoiceMonitorStatus status();
  VoiceMonitorResult end(uint64_t generation);
  void close() noexcept;
  void routeChanged();
  void refuse(const std::string& reason);
  // Service control callback; the service joins render before invoking it.
  static bool admit(void*, const AudioHostInventory&, const AudioHostConfig&, const AudioHostResult&) noexcept;
 private:
  SharedAudioService& service_;
  VoiceMonitorCapture& capture_;
  CommonVoiceMonitorRender render_;
  bool retained_{false}, lost_{false};
  uint64_t generation_{0}, route_{0};
  uint32_t channel_{0};
  std::string input_, reason_;
  VoiceMonitorLatency latency();
};
}
