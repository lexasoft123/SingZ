#include <audioapi/core/BaseAudioContext.h>
#include <audioapi/core/singz/SingzStretchNode.h>
#include <audioapi/utils/AudioBuffer.hpp>

#include "signalsmith-stretch.h"

#include <algorithm>
#include <cmath>
#include <vector>

namespace audioapi {

namespace {
constexpr float kBypassBelow = 0.01f;
constexpr int kMaxFrames = 8192;
constexpr int kMaxChannels = 2;
} // namespace

struct SingzStretchNode::Impl {
  signalsmith::stretch::SignalsmithStretch<float> stretch;
  std::vector<std::vector<float>> scratch;
  std::vector<float *> inPtrs;
  std::vector<float *> outPtrs;

  void configure(int channels, float sampleRate) {
    stretch.presetCheaper(channels, sampleRate);
    scratch.assign(channels, std::vector<float>(kMaxFrames, 0.0f));
    inPtrs.assign(channels, nullptr);
    outPtrs.assign(channels, nullptr);
  }
};

SingzStretchNode::SingzStretchNode(
    const std::shared_ptr<BaseAudioContext> &context,
    const AudioNodeOptions &options)
    : AudioNode(context, options), impl_(std::make_unique<Impl>()) {
  isInitialized_.store(true, std::memory_order_release);
}

SingzStretchNode::~SingzStretchNode() = default;

void SingzStretchNode::setSemitones(float semitones) {
  semitones_.store(semitones, std::memory_order_relaxed);
}

float SingzStretchNode::getLatencySeconds() const {
  return latencySec_.load(std::memory_order_relaxed);
}

std::shared_ptr<DSPAudioBuffer> SingzStretchNode::processNode(
    const std::shared_ptr<DSPAudioBuffer> &processingBuffer,
    int framesToProcess) {
  const float semis = semitones_.load(std::memory_order_relaxed);
  const auto context = context_.lock();
  if (context == nullptr) {
    return processingBuffer;
  }

  if (std::fabs(semis) < kBypassBelow) {
    if (engaged_) {
      engaged_ = false;
      latencySec_.store(0.0f, std::memory_order_relaxed);
    }
    return processingBuffer; // clean bypass: no latency, no CPU
  }

  const int channels = std::min(
      static_cast<int>(processingBuffer->getNumberOfChannels()), kMaxChannels);
  const int frames = std::min(framesToProcess, kMaxFrames);
  const float sampleRate = context->getSampleRate();

  if (!engaged_ || channels != configuredChannels_) {
    impl_->configure(channels, sampleRate);
    configuredChannels_ = channels;
    engaged_ = true;
    configuredSemitones_ = semis + 1.0f; // force the set below
    latencySec_.store(
        static_cast<float>(impl_->stretch.inputLatency() + impl_->stretch.outputLatency()) /
            sampleRate,
        std::memory_order_relaxed);
  }
  if (semis != configuredSemitones_) {
    // tonality limit keeps upper harmonics from smearing (their docs' value)
    impl_->stretch.setTransposeSemitones(semis, 8000.0f / sampleRate);
    configuredSemitones_ = semis;
  }

  for (int c = 0; c < channels; c++) {
    float *bus = processingBuffer->getChannel(c)->begin();
    std::copy(bus, bus + frames, impl_->scratch[c].begin());
    impl_->inPtrs[c] = impl_->scratch[c].data();
    impl_->outPtrs[c] = bus;
  }
  impl_->stretch.process(impl_->inPtrs, frames, impl_->outPtrs, frames);
  return processingBuffer;
}

} // namespace audioapi
