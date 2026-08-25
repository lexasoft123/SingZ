#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include "audio_input.h"

namespace singz {

struct LiveInputAnalysisWindow {
  uint64_t startSequence = 0;
  uint64_t endSequence = 0;
  uint64_t sampleHostTimeStartNs = 0;
  uint64_t sampleHostTimeEndNs = 0;  // exclusive end of the 2048-frame window
  uint64_t callbackHostTimeNs = 0;   // callback that supplied the final sample
  AudioInputTimestampQuality timestampQuality =
      AudioInputTimestampQuality::Unknown;
  double sampleRate = 0;
  LiveInputFrame analysis;
};

// Delivery-thread adapter from variable raw hardware blocks to the fixed
// 2048/512 live-analysis contract. Its pending window is a fixed circular
// buffer: no growing vector and no O(n) erase/memmove. Resampling and YIN stay
// off the hardware callback.
class LiveInputAnalysisAdapter {
 public:
  using Sink = std::function<void(const LiveInputAnalysisWindow&)>;

  LiveInputAnalysisAdapter();
  ~LiveInputAnalysisAdapter();
  LiveInputAnalysisAdapter(const LiveInputAnalysisAdapter&) = delete;
  LiveInputAnalysisAdapter& operator=(const LiveInputAnalysisAdapter&) = delete;

  bool push(const AudioInputBlockView& block, const Sink& sink);
  void reset();
  size_t bufferedFrames() const { return size_; }
  uint64_t resets() const { return resets_; }
  uint64_t emittedWindows() const { return emitted_; }

  static constexpr size_t analysisFrames() { return 2048; }
  static constexpr size_t hopFrames() { return 512; }

 private:
  void configure(const AudioInputBlockView& block);
  void append(float sample, uint64_t sequence, uint64_t callbackHostTimeNs,
              const Sink& sink);
  uint64_t hostTimeForOutputFrame(uint64_t frame) const;

  static constexpr size_t kCapacity = 2048;
  std::array<float, kCapacity> samples_{};
  std::array<uint64_t, kCapacity> sequences_{};
  std::array<uint64_t, kCapacity> callbackTimes_{};
  std::array<float, kCapacity> contiguous_{};
  size_t read_ = 0;
  size_t size_ = 0;
  uint64_t firstOutputFrame_ = 0;
  uint64_t nextOutputFrame_ = 0;
  uint64_t streamHostTimeNs_ = 0;
  uint64_t expectedSequence_ = 0;
  bool haveSequence_ = false;
  AudioInputTimestampQuality timestampQuality_ =
      AudioInputTimestampQuality::Unknown;
  int sourceRate_ = 0;
  int analysisRate_ = 0;
  int64_t latencyToDrop_ = 0;
  std::unique_ptr<class Resampler> resampler_;
  std::vector<float> converted_;
  uint64_t resets_ = 0;
  uint64_t emitted_ = 0;
};

}  // namespace singz
