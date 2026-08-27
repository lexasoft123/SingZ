#include <zdsp/analysis/capture_adapter.h>

#include <zdsp/audio_bus.h>
#include <zcore/legacy/resample.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <type_traits>

namespace zdsp::analysis {

struct LiveInputAnalysisAdapter::Storage {
  std::array<float, kCapacity> samples{};
  std::array<CaptureTime, kCapacity> captures{};
  std::array<uint64_t, kCapacity> callbackTimes{};
  std::array<float, kCapacity> contiguous{};
};

namespace {

CaptureTimestampQuality mapQuality(
    singz::AudioInputTimestampQuality quality) noexcept {
  switch (quality) {
    case singz::AudioInputTimestampQuality::Hardware:
      return CaptureTimestampQuality::Hardware;
    case singz::AudioInputTimestampQuality::CallbackEstimate:
      return CaptureTimestampQuality::Estimated;
    case singz::AudioInputTimestampQuality::Unknown:
      return CaptureTimestampQuality::Unknown;
  }
  return CaptureTimestampQuality::Unknown;
}

DiscontinuityReason mapReason(
    singz::AudioInputDiscontinuityReason reason) noexcept {
  switch (reason) {
    case singz::AudioInputDiscontinuityReason::None:
      return DiscontinuityReason::None;
    case singz::AudioInputDiscontinuityReason::StreamGenerationChanged:
      return DiscontinuityReason::StreamGenerationChanged;
    case singz::AudioInputDiscontinuityReason::SequenceGap:
      return DiscontinuityReason::SequenceGap;
    case singz::AudioInputDiscontinuityReason::SampleRateChanged:
      return DiscontinuityReason::SampleRateChanged;
    case singz::AudioInputDiscontinuityReason::TimestampQualityChanged:
      return DiscontinuityReason::TimestampQualityChanged;
    case singz::AudioInputDiscontinuityReason::ClockReanchored:
      return DiscontinuityReason::ClockReanchored;
    case singz::AudioInputDiscontinuityReason::DeviceLost:
      return DiscontinuityReason::DeviceLost;
    case singz::AudioInputDiscontinuityReason::SourceFrameOverflow:
      return DiscontinuityReason::SourceFrameOverflow;
  }
  return DiscontinuityReason::DeviceLost;
}

}  // namespace

bool mapCaptureMetadata(const singz::AudioInputBlockView& source,
                        CaptureTime& destination) noexcept {
  if (source.capture.clockDomainId == 0 ||
      source.capture.streamGeneration == 0) return false;
  const auto& capture = source.capture;
  constexpr uint32_t kKnownSourceFlags =
      singz::AudioInputSourceFrameValid |
      singz::AudioInputSampleHostTimeValid |
      singz::AudioInputCallbackHostTimeValid |
      singz::AudioInputTimestampQualityValid |
      singz::AudioInputStaleAnchor |
      singz::AudioInputDiscontinuous;
  if ((capture.flags & ~kKnownSourceFlags) != 0 ||
      ((capture.flags & singz::AudioInputStaleAnchor) != 0 &&
       (capture.flags & (singz::AudioInputSampleHostTimeValid |
                         singz::AudioInputTimestampQualityValid)) !=
           (singz::AudioInputSampleHostTimeValid |
            singz::AudioInputTimestampQualityValid))) return false;
  destination.clockDomain = {capture.clockDomainId};
  destination.streamGeneration = {capture.streamGeneration};
  destination.sequence = capture.sequence;
  destination.sourceFrame = {capture.sourceFrame};
  destination.sampleHostTime = {capture.sampleHostTimeNs};
  destination.callbackHostTime = {capture.callbackHostTimeNs};
  destination.quality = mapQuality(capture.timestampQuality);
  const DiscontinuityReason reason = mapReason(capture.discontinuity);
  destination.discontinuity = {
      reason, reason == DiscontinuityReason::None
                  ? DiscontinuityFlagNone
                  : DiscontinuityFlagResetState |
                        ((capture.flags & singz::AudioInputSampleHostTimeValid) != 0
                             ? DiscontinuityFlagTimeValid
                             : 0u)};
  destination.flags =
      ((capture.flags & singz::AudioInputSourceFrameValid) != 0
           ? CaptureTimeSourceFrameValid
           : 0u) |
      ((capture.flags & singz::AudioInputSampleHostTimeValid) != 0
           ? CaptureTimeSampleHostValid
           : 0u) |
      ((capture.flags & singz::AudioInputCallbackHostTimeValid) != 0
           ? CaptureTimeCallbackHostValid
           : 0u) |
      ((capture.flags & singz::AudioInputStaleAnchor) != 0
           ? CaptureTimeStaleAnchor
           : 0u) |
      ((capture.flags & singz::AudioInputTimestampQualityValid) != 0
           ? CaptureTimeTimestampQualityValid
           : 0u);
  return true;
}

namespace {
class SynchronousCaptureView final {
 public:
  SynchronousCaptureView(const singz::AudioInputBlockView& source,
                         const CaptureTime& mapped) noexcept
      : capture(mapped), channels{source.mono},
        bus{channels, 1, {source.frames}, {source.frames}, &capture} {}
  SynchronousCaptureView(const SynchronousCaptureView&) = delete;
  SynchronousCaptureView& operator=(const SynchronousCaptureView&) = delete;
  SynchronousCaptureView(SynchronousCaptureView&&) = delete;
  SynchronousCaptureView& operator=(SynchronousCaptureView&&) = delete;

  CaptureTime capture;
  const float* channels[1];
  ConstAudioBusView bus;
};
static_assert(!std::is_copy_constructible_v<SynchronousCaptureView>);
static_assert(!std::is_move_constructible_v<SynchronousCaptureView>);

constexpr uint32_t kAnchorValidityMask =
    CaptureTimeSourceFrameValid | CaptureTimeSampleHostValid |
    CaptureTimeTimestampQualityValid | CaptureTimeStaleAnchor;
}  // namespace

LiveInputAnalysisAdapter::LiveInputAnalysisAdapter(uint64_t generation)
    : storage_(std::make_unique<Storage>()),
      ownershipGeneration_(generation ? generation : 1) {
  converted_.reserve(kMaximumConvertedFrames);
}

LiveInputAnalysisAdapter::~LiveInputAnalysisAdapter() = default;

void LiveInputAnalysisAdapter::cancel(uint64_t generation) noexcept {
  if (generation == ownershipGeneration_)
    cancelled_.store(true, std::memory_order_release);
}

void LiveInputAnalysisAdapter::reset(DiscontinuityReason reason) {
  read_ = 0;
  size_ = 0;
  firstOutputFrame_ = 0;
  nextOutputFrame_ = 0;
  streamHostTimeNs_ = 0;
  streamSourceFrame_ = 0;
  havePrevious_ = false;
  previous_ = {};
  previousFrames_ = 0;
  sourceRate_ = 0;
  analysisRate_ = 0;
  latencyToDrop_ = 0;
  resampler_.reset();
  converted_.clear();
  lastResetReason_ = reason;
  ++resets_;
}

bool LiveInputAnalysisAdapter::configure(const CaptureTime& capture,
                                         double sourceRate) {
  read_ = 0;
  size_ = 0;
  firstOutputFrame_ = 0;
  nextOutputFrame_ = 0;
  streamHostTimeNs_ = capture.sampleHostTime.value;
  streamSourceFrame_ = capture.sourceFrame.value;
  sourceRate_ = static_cast<int>(std::llround(sourceRate));
  // Stay inside the source's rate family: 88.2/176.4 kHz analyze at 44.1 kHz
  // so the shared Resampler sees a true integer decimation (2:1/4:1) and
  // designs a real lowpass. A flat min(rate, 48000) put 88.2 kHz on the
  // 24-tap near-unity branch at an actual 1.84:1 — aliases folded in at
  // −8 dB (the "new consumer at a new ratio" trap resample.cpp records).
  analysisRate_ = sourceRate_ % 44100 == 0 ? std::min(sourceRate_, 44100)
                                           : std::min(sourceRate_, 48000);
  if (sourceRate_ != analysisRate_) {
    resampler_ = std::make_unique<singz::Resampler>(sourceRate_, analysisRate_, 1);
    latencyToDrop_ = resampler_->latencyOutFrames();
  } else {
    resampler_.reset();
    latencyToDrop_ = 0;
  }
  converted_.clear();
  return analysisRate_ >= 8000;
}

DiscontinuityReason LiveInputAnalysisAdapter::continuityReason(
    const CaptureTime& current, double sourceRate) const noexcept {
  if (current.discontinuity.reason != DiscontinuityReason::None)
    return current.discontinuity.reason;
  if (!havePrevious_) return DiscontinuityReason::None;
  if (current.streamGeneration.value != previous_.streamGeneration.value)
    return DiscontinuityReason::StreamGenerationChanged;
  if (current.clockDomain.value != previous_.clockDomain.value)
    return DiscontinuityReason::ClockReanchored;
  if (current.sequence != previous_.sequence + 1)
    return DiscontinuityReason::SequenceGap;
  if (static_cast<int>(std::llround(sourceRate)) != sourceRate_)
    return DiscontinuityReason::SampleRateChanged;
  if (current.quality != previous_.quality)
    return DiscontinuityReason::TimestampQualityChanged;
  if ((current.flags & kAnchorValidityMask) !=
      (previous_.flags & kAnchorValidityMask))
    return DiscontinuityReason::ClockReanchored;
  if ((current.flags & CaptureTimeSourceFrameValid) != 0 &&
      (previousFrames_ > std::numeric_limits<uint64_t>::max() -
                             previous_.sourceFrame.value ||
       current.sourceFrame.value != previous_.sourceFrame.value + previousFrames_))
    return previousFrames_ > std::numeric_limits<uint64_t>::max() -
                                 previous_.sourceFrame.value
               ? DiscontinuityReason::SourceFrameOverflow
               : DiscontinuityReason::SequenceGap;
  if ((current.flags & CaptureTimeSampleHostValid) != 0) {
    const long double expected =
        static_cast<long double>(previous_.sampleHostTime.value) +
        1000000000.0L * previousFrames_ / sourceRate;
    const long double tolerance = std::max<long double>(
        2000000.0L, 0.5L * 1000000000.0L * previousFrames_ / sourceRate);
    const long double actual =
        static_cast<long double>(current.sampleHostTime.value);
    if (actual <= static_cast<long double>(previous_.sampleHostTime.value) ||
        std::fabs(actual - expected) > tolerance)
      return DiscontinuityReason::ClockReanchored;
  }
  return DiscontinuityReason::None;
}

uint64_t LiveInputAnalysisAdapter::hostTimeForOutputFrame(
    uint64_t frame) const noexcept {
  if (!streamHostTimeNs_ || analysisRate_ <= 0) return 0;
  const long double projected = static_cast<long double>(streamHostTimeNs_) +
      static_cast<long double>(frame) * 1000000000.0L / analysisRate_;
  if (projected <= 0 || projected > 9.0e18L) return 0;
  return static_cast<uint64_t>(projected);
}

uint64_t LiveInputAnalysisAdapter::sourceFrameForOutputFrame(
    uint64_t frame) const noexcept {
  if (sourceRate_ <= 0 || analysisRate_ <= 0) return streamSourceFrame_;
  const uint64_t sourceRate = static_cast<uint64_t>(sourceRate_);
  const uint64_t analysisRate = static_cast<uint64_t>(analysisRate_);
  const uint64_t whole = frame / analysisRate;
  const uint64_t remainder = frame % analysisRate;
  const uint64_t available =
      std::numeric_limits<uint64_t>::max() - streamSourceFrame_;
  if (whole > available / sourceRate)
    return std::numeric_limits<uint64_t>::max();
  const uint64_t wholeFrames = whole * sourceRate;
  const uint64_t fractionalFrames = remainder * sourceRate / analysisRate;
  if (fractionalFrames > available - wholeFrames)
    return std::numeric_limits<uint64_t>::max();
  return streamSourceFrame_ + wholeFrames + fractionalFrames;
}

void LiveInputAnalysisAdapter::append(float sample, const CaptureTime& capture,
                                      uint64_t callbackHostTimeNs,
                                      const Sink& sink) {
  if (size_ >= kCapacity) return;
  const size_t write = (read_ + size_) % kCapacity;
  storage_->samples[write] = std::isfinite(sample) ? sample : 0.0f;
  storage_->captures[write] = capture;
  storage_->callbackTimes[write] = callbackHostTimeNs;
  if (size_ == 0) firstOutputFrame_ = nextOutputFrame_;
  ++size_;
  ++nextOutputFrame_;
  while (size_ == kCapacity) {
    for (size_t i = 0; i < kCapacity; ++i)
      storage_->contiguous[i] = storage_->samples[(read_ + i) % kCapacity];
    AnalysisWindow window;
    window.start = storage_->captures[read_];
    window.end = storage_->captures[(read_ + kCapacity - 1) % kCapacity];
    window.start.sampleHostTime = {hostTimeForOutputFrame(firstOutputFrame_)};
    window.end.sampleHostTime = {
        hostTimeForOutputFrame(firstOutputFrame_ + kCapacity)};
    window.start.sourceFrame = {sourceFrameForOutputFrame(firstOutputFrame_)};
    window.end.sourceFrame = {
        sourceFrameForOutputFrame(firstOutputFrame_ + kCapacity)};
    window.deliveredAt = {
        storage_->callbackTimes[(read_ + kCapacity - 1) % kCapacity]};
    window.sampleRate = {static_cast<double>(analysisRate_)};
    window.ownershipGeneration = ownershipGeneration_;
    window.resetCount = resets_;
    window.resetReason = lastResetReason_;
    window.analysis = analyzeLiveInput(storage_->contiguous.data(), kCapacity,
                                       analysisRate_);
    if (!cancelled_.load(std::memory_order_acquire)) sink(window);
    ++emitted_;
    read_ = (read_ + hopFrames()) % kCapacity;
    size_ -= hopFrames();
    firstOutputFrame_ += hopFrames();
  }
}

bool LiveInputAnalysisAdapter::push(const singz::AudioInputBlockView& source,
                                    const Sink& sink) {
  if (cancelled_.load(std::memory_order_acquire) || !sink || !source.mono ||
      source.frames == 0 ||
      source.frames > kMaximumInputFrames ||
      !std::isfinite(source.sampleRate) || source.sampleRate < 8000 ||
      source.sampleRate > 384000) return false;
  CaptureTime mapped;
  if (!mapCaptureMetadata(source, mapped)) return false;
  SynchronousCaptureView block(source, mapped);
  const DiscontinuityReason reason =
      continuityReason(block.capture, source.sampleRate);
  if (!havePrevious_ || reason != DiscontinuityReason::None) {
    // A producer can report a typed boundary on the first accepted block
    // (for example, the first block delivered after a ring overrun or device
    // recovery). Record that reset before configuring the new domain or
    // feeding any of its samples. On later blocks the same branch performs
    // exactly one reset for the continuity boundary.
    if (reason != DiscontinuityReason::None) reset(reason);
    if (!configure(block.capture, source.sampleRate)) return false;
  }
  // Publish continuity state before analysis only after reset/configure has
  // completed. No old-domain partial window can observe new-domain samples.
  previous_ = block.capture;
  previousFrames_ = source.frames;
  havePrevious_ = true;

  const float* output = block.bus.channels[0];
  size_t count = block.bus.frames.value;
  if (resampler_) {
    converted_.clear();
    resampler_->process(block.bus.channels[0], source.frames, converted_);
    if (converted_.size() > kMaximumConvertedFrames) {
      reset(DiscontinuityReason::SequenceGap);
      return false;
    }
    output = converted_.data();
    count = converted_.size();
  }
  size_t offset = 0;
  if (latencyToDrop_ > 0) {
    const size_t drop = std::min<size_t>(
        count, static_cast<size_t>(latencyToDrop_));
    latencyToDrop_ -= static_cast<int64_t>(drop);
    offset = drop;
  }
  for (size_t index = offset; index < count; ++index)
    append(output[index], block.capture,
           block.capture.callbackHostTime.value, sink);
  return true;
}

}  // namespace zdsp::analysis
