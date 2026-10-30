#pragma once

#include <audioapi/core/AudioNode.h>

#include <atomic>
#include <memory>

namespace audioapi {

/**
 * SingZ master-bus pitch shifter (Signalsmith Stretch, 1:1 time). Tempo comes
 * from source varispeed; this node corrects the resulting pitch and applies
 * the user's transpose: semitones = transpose - 12*log2(rate). At 0 semitones
 * it bypasses entirely (no latency, no CPU); engaged it adds its reported
 * latency, which JS folds into the display-latency compensation.
 */
class SingzStretchNode : public AudioNode {
 public:
  explicit SingzStretchNode(
      const std::shared_ptr<BaseAudioContext> &context,
      const AudioNodeOptions &options);
  ~SingzStretchNode() override;

  void setSemitones(float semitones);
  [[nodiscard]] float getLatencySeconds() const;
  float outputPeak() const { return outputPeak_.load(std::memory_order_relaxed); }
  uint32_t clippedBlocks() const { return clippedBlocks_.load(std::memory_order_relaxed); }

 protected:
  std::shared_ptr<DSPAudioBuffer> processNode(
      const std::shared_ptr<DSPAudioBuffer> &processingBuffer,
      int framesToProcess) override;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  std::atomic<float> semitones_{0.0f};
  std::atomic<float> latencySec_{0.0f};
  void meterOutput(const std::shared_ptr<DSPAudioBuffer> &buffer, int frames, float sampleRate);
  std::atomic<float> outputPeak_{0};
  std::atomic<uint32_t> clippedBlocks_{0};
  bool engaged_ = false;
  float configuredSemitones_ = 0.0f;
  int configuredChannels_ = 0;
};

} // namespace audioapi
