#pragma once
#include <zcore/device/audio_input.h>
#include <memory>
#include <array>
#include <span>
#include <chrono>
#include <loopz/audio_scene.hpp>
namespace singz {
namespace box_input_detail {
// Shared worker/test seam: sparse read only, never a full-layout fallback.
std::optional<loopz::AudioReadResult> readEnabledChannels(
    const loopz::AudioSource&, uint64_t host, double rate, loopz::RoutingOutput,
    uint32_t frames, loopz::AudioReadCursor&, std::span<const uint32_t>) noexcept;
}
// Private native-rate analysis tap of the LoopZ-owned capture bus. Lifecycle calls run on
// the routing control owner; stop drains its reader before releasing the lease.
struct BoxInputMeter {
  bool valid{false};
  uint32_t channels{0};
  std::array<float, 64> peak{}, rms{};
  std::array<uint32_t, 64> channelIndices{};
};
class BoxInputCapture final {
 public:
  explicit BoxInputCapture(std::chrono::milliseconds peakHold = std::chrono::milliseconds{250});
  ~BoxInputCapture();
  BoxInputCapture(const BoxInputCapture&) = delete;
  BoxInputCapture& operator=(const BoxInputCapture&) = delete;
  AudioInputResult start(const AudioInputConfig&, AudioInputSink,
                        const std::vector<AudioInputDevice>* = nullptr,
                        std::span<const uint32_t> enabledChannels = {});
  void stop(bool retainPrepared = false);
  AudioInputStats stats() const;
  // Diagnostics observe the latest block; only the fast meter drains the hold.
  BoxInputMeter meter(bool consumePeak = false) const;
  AudioInputState state() const;
  std::string lastError() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}
