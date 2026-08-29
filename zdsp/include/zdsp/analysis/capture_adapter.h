#pragma once

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
  /** Decaying peak of the raw capture, before detector-only normalization. */
  float capturePeak() const noexcept { return peakFollower_; }
  /** Gain applied to the most recent window; 1 means it was untouched. */
  float appliedGain() const noexcept { return appliedGain_; }

  // Live capture level is device-selected while the legacy YIN detector has
  // an absolute RMS gate. Normalize only a voiced window's analysis copy so a
  // quiet phone reaches that detector, while reporting the unscaled hardware
  // level. Gain is boost-only and bounded; an already-hot input stays on the
  // bit-identical direct path.
  static constexpr float kTargetPeak = 0.25f;    // −12 dBFS
  static constexpr float kMaximumGain = 100.0f;  // +40 dB
  static constexpr float kPeakDecay = 0.995f;    // ~2.1 s at 512/48 kHz

  // Decide voicing before gain. The onset latch rejects one-window impulses;
  // hysteretic release lets a sung note ride brief dips without leaving the
  // gate open on a quieter tonal room for the rest of the exercise.
  static constexpr double kVoicingOpenRms = 0.0018;   // −55 dBFS
  static constexpr double kVoicingCloseRms = 0.0010;  // −60 dBFS
  static constexpr int kVoicingOnsetWindows = 3;
  static constexpr int kVoicingReleaseWindows = 30;
  static constexpr double kDetectorGateRms = 0.012;

  static constexpr size_t analysisFrames() noexcept { return 2048; }
  static constexpr size_t hopFrames() noexcept { return 512; }

 private:
  bool configure(const CaptureTime& capture, double sourceRate);
  LiveInputFrame analyzeWindow();
  void append(float sample, const CaptureTime& capture,
              uint64_t callbackHostTimeNs, const Sink& sink);
  uint64_t hostTimeForOutputFrame(uint64_t frame) const noexcept;
  uint64_t sourceFrameForOutputFrame(uint64_t frame) const noexcept;
  DiscontinuityReason continuityReason(const CaptureTime& capture,
                                       double sourceRate) const noexcept;

  static constexpr size_t kCapacity = 2048;
  static constexpr uint32_t kMaximumInputFrames = 16384;
  static constexpr size_t kMaximumConvertedFrames = 65536;
  struct Storage;
  // The fixed analysis ring is allocated once on the ordinary control thread.
  // Keeping it out of the facade prevents a few stack-allocated adapters from
  // exhausting Windows' default 1 MiB thread stack.
  std::unique_ptr<Storage> storage_;
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
  float peakFollower_ = 0.0f;
  float appliedGain_ = 1.0f;
  bool voicing_ = false;
  int onsetWindows_ = 0;
  int releaseWindows_ = 0;
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
