#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include <zcore/audio/audio_input_transport.h>

#include <zdsp/analysis/live_input_analysis.h>
#include <zdsp/clock.h>

namespace singz { class Resampler; }

namespace zdsp::analysis {

// Explicit higher-layer boundary linking zcore device transport to zdsp.
// zcore itself remains unaware of DSP types.
// Maps only owned/copyable provenance. The synchronous PCM/bus view used by
// push is private to the implementation and cannot be retained by callers.
[[nodiscard]] bool mapCaptureMetadata(
    const singz::AudioInputBlockView& source,
    CaptureTime& destination) noexcept;

struct AnalysisWindow {
  CaptureTime start{};
  CaptureTime end{};
  HostTimeNs deliveredAt{};
  SampleRateHz sampleRate{};
  uint64_t ownershipGeneration = 0;
  uint64_t resetCount = 0;
  DiscontinuityReason resetReason = DiscontinuityReason::None;
  LiveInputFrame analysis{};
};

// Stateful compatibility adapter for the current 2048/512 live pitch path.
// It runs only from AudioInput's ordinary delivery thread. Any fixed-ratio
// resampling remains here and never becomes a render/output-clock node.
class LiveInputAnalysisAdapter {
 public:
  using Sink = std::function<void(const AnalysisWindow&)>;

  explicit LiveInputAnalysisAdapter(uint64_t ownershipGeneration = 1);
  ~LiveInputAnalysisAdapter();
  LiveInputAnalysisAdapter(const LiveInputAnalysisAdapter&) = delete;
  LiveInputAnalysisAdapter& operator=(const LiveInputAnalysisAdapter&) = delete;

  bool push(const singz::AudioInputBlockView& block, const Sink& sink);
  // The only cross-thread operation: atomically suppresses scalar delivery.
  // stop/join still precedes destruction or reset of analyzer state.
  void cancel(uint64_t ownershipGeneration) noexcept;
  // Ordinary delivery thread only; never call concurrently with push().
  void reset(DiscontinuityReason reason = DiscontinuityReason::None);
  size_t bufferedFrames() const noexcept { return size_; }
  uint64_t resets() const noexcept { return resets_; }
  uint64_t emittedWindows() const noexcept { return emitted_; }
  uint64_t ownershipGeneration() const noexcept { return ownershipGeneration_; }

  static constexpr size_t analysisFrames() noexcept { return 2048; }
  static constexpr size_t hopFrames() noexcept { return 512; }

 private:
  bool configure(const CaptureTime& capture, double sourceRate);
  void append(float sample, const CaptureTime& capture,
              uint64_t callbackHostTimeNs, const Sink& sink);
  uint64_t hostTimeForOutputFrame(uint64_t frame) const noexcept;
  uint64_t sourceFrameForOutputFrame(uint64_t frame) const noexcept;
  DiscontinuityReason continuityReason(const CaptureTime& capture,
                                       double sourceRate) const noexcept;

  static constexpr size_t kCapacity = 2048;
  static constexpr uint32_t kMaximumInputFrames = 16384;
  static constexpr size_t kMaximumConvertedFrames = 65536;
  std::array<float, kCapacity> samples_{};
  std::array<CaptureTime, kCapacity> captures_{};
  std::array<uint64_t, kCapacity> callbackTimes_{};
  std::array<float, kCapacity> contiguous_{};
  size_t read_ = 0;
  size_t size_ = 0;
  uint64_t firstOutputFrame_ = 0;
  uint64_t nextOutputFrame_ = 0;
  uint64_t streamHostTimeNs_ = 0;
  uint64_t streamSourceFrame_ = 0;
  CaptureTime previous_{};
  uint32_t previousFrames_ = 0;
  bool havePrevious_ = false;
  int sourceRate_ = 0;
  int analysisRate_ = 0;
  int64_t latencyToDrop_ = 0;
  std::unique_ptr<singz::Resampler> resampler_;
  std::vector<float> converted_;
  uint64_t ownershipGeneration_ = 1;
  std::atomic<bool> cancelled_{false};
  uint64_t resets_ = 0;
  uint64_t emitted_ = 0;
  DiscontinuityReason lastResetReason_ = DiscontinuityReason::None;
};

struct VocalTrainingCapturePreset {
  uint32_t channelCount = 1;
  uint32_t analysisFrames = 2048;
  uint32_t analysisHopFrames = 512;
  bool levelTap = true;
  bool pitchTap = true;
  bool outputEnabled = false;
};

constexpr VocalTrainingCapturePreset vocalTrainingCapturePreset() noexcept {
  return {};
}

}  // namespace zdsp::analysis
