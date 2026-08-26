#include <zcore/legacy/audio_input_analysis_adapter.h>

#include <algorithm>
#include <cmath>
#include <limits>

#include <zcore/legacy/resample.h>

namespace singz {

namespace {
constexpr uint32_t kMaximumInputFrames = 16384;
constexpr size_t kMaximumConvertedFrames = kMaximumInputFrames + 512;
}

LiveInputAnalysisAdapter::LiveInputAnalysisAdapter() {
  converted_.reserve(kMaximumConvertedFrames);
}

LiveInputAnalysisAdapter::~LiveInputAnalysisAdapter() = default;

void LiveInputAnalysisAdapter::reset() {
  read_ = 0;
  size_ = 0;
  firstOutputFrame_ = 0;
  nextOutputFrame_ = 0;
  streamHostTimeNs_ = 0;
  expectedSequence_ = 0;
  haveSequence_ = false;
  timestampQuality_ = AudioInputTimestampQuality::Unknown;
  sourceRate_ = 0;
  analysisRate_ = 0;
  latencyToDrop_ = 0;
  resampler_.reset();
  converted_.clear();
  ++resets_;
}

void LiveInputAnalysisAdapter::configure(const AudioInputBlockView& block) {
  read_ = 0;
  size_ = 0;
  firstOutputFrame_ = 0;
  nextOutputFrame_ = 0;
  streamHostTimeNs_ = block.sampleHostTimeNs;
  timestampQuality_ = block.timestampQuality;
  sourceRate_ = static_cast<int>(std::llround(block.sampleRate));
  analysisRate_ = std::min(sourceRate_, 48000);
  if (sourceRate_ != analysisRate_) {
    resampler_ = std::make_unique<Resampler>(sourceRate_, analysisRate_, 1);
    latencyToDrop_ = resampler_->latencyOutFrames();
  } else {
    resampler_.reset();
    latencyToDrop_ = 0;
  }
  converted_.clear();
}

uint64_t LiveInputAnalysisAdapter::hostTimeForOutputFrame(uint64_t frame) const {
  if (!streamHostTimeNs_ || analysisRate_ <= 0) return 0;
  const long double projected = static_cast<long double>(streamHostTimeNs_) +
      static_cast<long double>(frame) * 1000000000.0L / analysisRate_;
  constexpr long double kMaximumHostTimeNs = 9.0e18L;
  if (projected <= 0 || projected > kMaximumHostTimeNs) return 0;
  return static_cast<uint64_t>(projected);
}

void LiveInputAnalysisAdapter::append(float sample, uint64_t sequence,
                                      uint64_t callbackHostTimeNs,
                                      const Sink& sink) {
  // A completed window is emitted and hopped immediately, so capacity can
  // never be exceeded even when one hardware callback supplies many windows.
  if (size_ >= kCapacity) return;
  const size_t write = (read_ + size_) % kCapacity;
  samples_[write] = std::isfinite(sample) ? sample : 0.0f;
  sequences_[write] = sequence;
  callbackTimes_[write] = callbackHostTimeNs;
  if (size_ == 0) firstOutputFrame_ = nextOutputFrame_;
  ++size_;
  ++nextOutputFrame_;
  // Keep this as a drain loop rather than a single-window special case: the
  // adapter's invariant is that every complete hop is consumed before more
  // input is accepted. Appending one sample means this normally iterates once,
  // while still making the bounded-backlog contract explicit and testable.
  while (size_ == kCapacity) {
    for (size_t i = 0; i < kCapacity; ++i)
      contiguous_[i] = samples_[(read_ + i) % kCapacity];
    LiveInputAnalysisWindow window;
    window.startSequence = sequences_[read_];
    window.endSequence = sequences_[(read_ + kCapacity - 1) % kCapacity];
    window.sampleHostTimeStartNs = hostTimeForOutputFrame(firstOutputFrame_);
    window.sampleHostTimeEndNs = hostTimeForOutputFrame(firstOutputFrame_ + kCapacity);
    window.callbackHostTimeNs = callbackTimes_[(read_ + kCapacity - 1) % kCapacity];
    window.timestampQuality = timestampQuality_;
    window.sampleRate = analysisRate_;
    window.analysis = analyzeLiveInput(contiguous_.data(), kCapacity, analysisRate_);
    sink(window);
    ++emitted_;

    read_ = (read_ + hopFrames()) % kCapacity;
    size_ -= hopFrames();
    firstOutputFrame_ += hopFrames();
  }
}

bool LiveInputAnalysisAdapter::push(const AudioInputBlockView& block, const Sink& sink) {
  if (!sink || !block.mono || block.frames == 0 || block.frames > kMaximumInputFrames ||
      !std::isfinite(block.sampleRate) || block.sampleRate < 8000 ||
      block.sampleRate > 384000) {
    return false;
  }
  const int roundedRate = static_cast<int>(std::llround(block.sampleRate));
  const bool discontinuity = haveSequence_ && block.sequence != expectedSequence_;
  const bool timestampDomainChanged =
      haveSequence_ && block.timestampQuality != timestampQuality_;
  // AAudio can begin on a callback-entry estimate, acquire a hardware anchor,
  // and temporarily fall back if that anchor becomes stale. Even though both
  // clocks are CLOCK_MONOTONIC, their sample-position origins need not match.
  // Re-anchor on either transition so one analysis window never mixes them.
  if (!haveSequence_ || discontinuity || roundedRate != sourceRate_ ||
      timestampDomainChanged) {
    if (haveSequence_) ++resets_;
    configure(block);
  }
  haveSequence_ = true;
  expectedSequence_ = block.sequence + 1;

  const float* output = block.mono;
  size_t count = block.frames;
  if (resampler_) {
    converted_.clear();
    resampler_->process(block.mono, block.frames, converted_);
    if (converted_.size() > kMaximumConvertedFrames) {
      reset();
      return false;
    }
    output = converted_.data();
    count = converted_.size();
  }
  size_t offset = 0;
  if (latencyToDrop_ > 0) {
    const size_t drop = std::min<size_t>(count, static_cast<size_t>(latencyToDrop_));
    latencyToDrop_ -= static_cast<int64_t>(drop);
    offset = drop;
  }
  for (size_t i = offset; i < count; ++i)
    append(output[i], block.sequence, block.callbackHostTimeNs, sink);
  return true;
}

}  // namespace singz
