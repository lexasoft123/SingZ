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
  peakFollower_ = 0.0f;
  appliedGain_ = 1.0f;
  voicing_ = false;
  onsetWindows_ = 0;
  releaseWindows_ = 0;
  ++resets_;
}

void LiveInputAnalysisAdapter::configure(const AudioInputBlockView& block) {
  // Gate and follower state belongs to a run of audio, not to the object. This
  // is the re-anchor path that actually runs in the field (a sequence gap, or
  // an AAudio timestamp-domain flip); reset() is reached only by the converted
  // -overflow path, so clearing there alone left the gate open across a
  // re-anchor.
  voicing_ = false;
  onsetWindows_ = 0;
  releaseWindows_ = 0;
  peakFollower_ = 0.0f;
  appliedGain_ = 1.0f;
  read_ = 0;
  size_ = 0;
  firstOutputFrame_ = 0;
  nextOutputFrame_ = 0;
  streamHostTimeNs_ = block.sampleHostTimeNs;
  timestampQuality_ = block.timestampQuality;
  sourceRate_ = static_cast<int>(std::llround(block.sampleRate));
  // Mirrors zdsp's capture adapter: 44.1 kHz-family sources analyze at
  // 44.1 kHz so the Resampler's tap heuristic sees an integer decimation
  // (min(rate, 48000) put 88.2 kHz on the 24-tap near-unity branch).
  analysisRate_ = sourceRate_ % 44100 == 0 ? std::min(sourceRate_, 44100)
                                           : std::min(sourceRate_, 48000);
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
    window.analysis = analyzeWindow();
    sink(window);
    ++emitted_;

    read_ = (read_ + hopFrames()) % kCapacity;
    size_ -= hopFrames();
    firstOutputFrame_ += hopFrames();
  }
}

/**
 * Normalize this window to the level the shared detector expects, then report
 * the level the HARDWARE actually delivered.
 *
 * Both halves matter. Analysing the scaled copy is what lets a quiet phone be
 * heard at all; reporting the unscaled rms is what keeps the log honest about
 * that phone, so "the mic is quiet" stays visible instead of being papered
 * over by the very gain that fixed it.
 */
LiveInputFrame LiveInputAnalysisAdapter::analyzeWindow() {
  float peak = 0.0f;
  double sumSquares = 0;
  for (size_t i = 0; i < kCapacity; ++i) {
    const float sample = contiguous_[i];
    peak = std::max(peak, std::fabs(sample));
    sumSquares += static_cast<double>(sample) * sample;
  }
  const double rawRms = std::sqrt(sumSquares / static_cast<double>(kCapacity));
  peakFollower_ = std::max(peak, peakFollower_ * kPeakDecay);

  // Voicing is decided here, on the level the microphone actually delivered,
  // BEFORE any lift, and with hysteresis so a room cannot cross in one step.
  if (voicing_) {
    // Two ways out. Straight under the close level shuts it at once; so does
    // simply failing to reach the OPEN level for long enough, which is what
    // stops the gate latching open for the rest of a session after the first
    // note — a room between the two edges would otherwise stay pitched.
    releaseWindows_ = rawRms >= kVoicingOpenRms ? 0 : releaseWindows_ + 1;
    if (rawRms < kVoicingCloseRms || releaseWindows_ >= kVoicingReleaseWindows) {
      voicing_ = false;
      onsetWindows_ = 0;
      releaseWindows_ = 0;
    }
  } else if (rawRms >= kVoicingOpenRms) {
    if (++onsetWindows_ >= kVoicingOnsetWindows) {
      voicing_ = true;
      releaseWindows_ = 0;
    }
  } else {
    onsetWindows_ = 0;
  }
  if (!voicing_) {
    appliedGain_ = 1.0f;
    LiveInputFrame frame;
    frame.rms = rawRms;
    frame.dbfs = rawRms > 0 ? std::max(-120.0, 20.0 * std::log10(rawRms)) : -120.0;
    return frame;
  }

  // Reached only while voicing_, which guarantees peakFollower_ >= rawRms >=
  // kVoicingCloseRms — so there is no silence left to guard against here.
  appliedGain_ =
      std::min(kMaximumGain, std::max(1.0f, kTargetPeak / peakFollower_));
  // The peak-derived gain answers "how far under the target is the loudest
  // thing recently"; it does not answer "will this window clear the detector's
  // own gate". After a loud transient the follower can hold the gain far too
  // low for a voice that is plainly present, so floor it at what passes.
  if (rawRms > 0) {
    appliedGain_ = std::min(
        kMaximumGain,
        std::max(appliedGain_, static_cast<float>(kDetectorGateRms / rawRms)));
  }
  if (appliedGain_ == 1.0f)
    return analyzeLiveInput(contiguous_.data(), kCapacity, analysisRate_);

  for (size_t i = 0; i < kCapacity; ++i) scaled_[i] = contiguous_[i] * appliedGain_;
  LiveInputFrame frame = analyzeLiveInput(scaled_.data(), kCapacity, analysisRate_);
  // frequency and clarity come from the scaled window (YIN is scale-invariant,
  // so they are the same answer the detector would give at any level); rms and
  // dbfs are restored to what the microphone handed us.
  frame.rms /= appliedGain_;
  frame.dbfs = frame.rms > 0 ? std::max(-120.0, 20.0 * std::log10(frame.rms)) : -120.0;
  return frame;
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
