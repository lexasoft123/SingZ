#include "lane_measure.h"

#include "streaming_lane_feeder.h"

#include <zcore/media/streaming_audio_source.h>

#include <algorithm>
#include <cmath>
#include <exception>
#include <thread>
#include <utility>

namespace singz {

static_assert(kLaneMeasureEnvelopeBuckets == kStreamingWaveformBuckets,
              "the measure's envelope must be the seek bar's statistic");

namespace {

constexpr size_t kBlockFrames = 16384;

// computePeaks' partition (src/renderer/src/audio/peaks.ts), in the same
// double arithmetic: `step = length / buckets`, bucket b spans
// [floor(b * step), max(that + 1, floor((b + 1) * step))) and the last bucket
// runs to the end. With at least one frame per bucket the ranges tile the
// lane; with fewer frames than buckets they overlap, and a frame then counts
// toward every bucket whose range holds it — which is why that case is read
// whole and walked bucket by bucket rather than frame by frame.
struct FinePartition {
  uint64_t frames{0};
  uint32_t buckets{1};
  double step{1.0};

  [[nodiscard]] uint64_t start(uint32_t bucket) const noexcept {
    return static_cast<uint64_t>(
        std::floor(static_cast<double>(bucket) * step));
  }
  [[nodiscard]] uint64_t end(uint32_t bucket) const noexcept {
    if (bucket + 1 < buckets) {
      const uint64_t next = static_cast<uint64_t>(
          std::floor(static_cast<double>(bucket + 1) * step));
      return std::max(start(bucket) + 1, next);
    }
    return frames;
  }
};

// The seek bar's partition, walked forward: bucket b is
// [b * frames / buckets, (b + 1) * frames / buckets) with an end that is
// always past its begin — the same integer arithmetic as summarizeLanePeaks
// and the feeder's waveform pass, so the three pictures agree to the frame.
struct EnvelopeCursor {
  uint64_t frames{0};
  size_t bucket{0};
  uint64_t end{1};

  explicit EnvelopeCursor(uint64_t frameCount) noexcept : frames(frameCount) {
    end = frames / kLaneMeasureEnvelopeBuckets;
    if (end == 0) end = 1;
  }
  void advanceTo(uint64_t absolute) noexcept {
    while (bucket + 1 < kLaneMeasureEnvelopeBuckets && absolute >= end) {
      ++bucket;
      end = (bucket + 1) * frames / kLaneMeasureEnvelopeBuckets;
      const uint64_t begin = bucket * frames / kLaneMeasureEnvelopeBuckets;
      if (end <= begin) end = begin + 1;
    }
  }
};

struct Accumulators {
  std::array<double, kLaneMeasureEnvelopeBuckets> energy{};
  std::array<uint64_t, kLaneMeasureEnvelopeBuckets> counted{};
  double sumSquares{0.0};
  uint64_t samples{0};
};

// One block of frames into the envelope and the whole-lane RMS. The fine
// peaks are folded separately, because their two regimes read differently.
void accumulateBlock(const std::vector<std::vector<float>>& planes,
                     uint32_t channels, uint64_t at, size_t got,
                     EnvelopeCursor& cursor, Accumulators& acc) noexcept {
  for (size_t frame = 0; frame < got; ++frame) {
    cursor.advanceTo(at + frame);
    for (uint32_t channel = 0; channel < channels; ++channel) {
      const float sample = planes[channel][frame];
      // Non-finite PCM cannot reach a drawing surface as a height.
      if (!std::isfinite(sample)) continue;
      const double squared =
          static_cast<double>(sample) * static_cast<double>(sample);
      acc.energy[cursor.bucket] += squared;
      ++acc.counted[cursor.bucket];
      acc.sumSquares += squared;
      ++acc.samples;
    }
  }
}

// computePeaks reads the first two channels only, and `v > max` is how a
// NaN never becomes the bucket's height there — kept as written.
void foldPeak(float& slot, float sample) noexcept {
  const float magnitude = sample < 0.0F ? -sample : sample;
  if (magnitude > slot) slot = magnitude;
}

void finish(LaneMeasure& out, const Accumulators& acc) noexcept {
  for (size_t bucket = 0; bucket < kLaneMeasureEnvelopeBuckets; ++bucket) {
    const double level =
        acc.counted[bucket] == 0
            ? 0.0
            : std::sqrt(acc.energy[bucket] /
                        static_cast<double>(acc.counted[bucket]));
    out.envelope[bucket] = level > 1.0 ? 1.0F : static_cast<float>(level);
  }
  out.rms = acc.samples == 0
                ? 0.0F
                : static_cast<float>(std::sqrt(
                      acc.sumSquares / static_cast<double>(acc.samples)));
  out.status = DecodedAudioStatus::Ok;
  out.ok = true;
}

}  // namespace

uint32_t laneMeasurePeakBuckets(double durationSeconds,
                                const LaneMeasurePolicy& policy) noexcept {
  const uint32_t minimum = std::max<uint32_t>(1, policy.minimumPeaks);
  const uint32_t maximum = std::max(minimum, policy.maximumPeaks);
  if (!std::isfinite(durationSeconds) || durationSeconds <= 0.0) return minimum;
  // Math.round for a positive argument.
  const double rounded = std::floor(
      durationSeconds * static_cast<double>(policy.peaksPerSecond) + 0.5);
  if (rounded >= static_cast<double>(maximum)) return maximum;
  if (rounded <= static_cast<double>(minimum)) return minimum;
  return static_cast<uint32_t>(rounded);
}

LaneMeasure measureLane(LaneMeasureRequest request,
                        const DecodeCancellation& cancel) noexcept {
  LaneMeasure out;
  out.id = std::move(request.id);
  try {
    DecodedAudioStatus status = DecodedAudioStatus::InvalidArgument;
    StreamingAudioOpenOptions open{};
    std::unique_ptr<StreamingAudioSource> source =
        openStreamingAudioSource(std::move(request.descriptor), open, &status);
    if (source == nullptr) {
      out.status = status == DecodedAudioStatus::Ok
                       ? DecodedAudioStatus::UnsupportedFormat
                       : status;
      return out;
    }
    const StreamingAudioInfo& info = source->info();
    if (info.sampleRate == 0 || info.channels == 0 || info.frameCount == 0) {
      out.status = DecodedAudioStatus::MalformedData;
      return out;
    }
    const uint64_t frames = info.frameCount;
    const uint32_t channels = info.channels;
    out.sampleRate = info.sampleRate;
    out.channels = channels;
    out.frameCount = frames;
    out.durationSeconds =
        static_cast<double>(frames) / static_cast<double>(info.sampleRate);
    const uint32_t buckets =
        laneMeasurePeakBuckets(out.durationSeconds, request.policy);
    out.peaks.assign(buckets, 0.0F);
    const uint32_t peakChannels = std::min<uint32_t>(2, channels);
    const FinePartition partition{frames, buckets,
                                  static_cast<double>(frames) /
                                      static_cast<double>(buckets)};
    EnvelopeCursor cursor(frames);
    Accumulators acc;

    if (frames < buckets) {
      // The overlapping regime — a lane shorter than its own bucket count,
      // which at the renderer's policy is under 2400 frames. Read whole and
      // walk it exactly as computePeaks does.
      std::vector<std::vector<float>> all(
          channels, std::vector<float>(static_cast<size_t>(frames), 0.0F));
      std::vector<float*> pointers(channels);
      uint64_t at = 0;
      while (at < frames) {
        if (cancel.isRequested()) {
          out.status = DecodedAudioStatus::Cancelled;
          return out;
        }
        for (uint32_t channel = 0; channel < channels; ++channel)
          pointers[channel] = all[channel].data() + at;
        size_t got = 0;
        const DecodedAudioStatus read = source->read(
            pointers.data(), static_cast<size_t>(frames - at), &got);
        if (read != DecodedAudioStatus::Ok) {
          out.status = read;
          return out;
        }
        if (got == 0) break;
        at += got;
      }
      // Frames the file did not deliver stay silent rather than absent.
      accumulateBlock(all, channels, 0, static_cast<size_t>(at), cursor, acc);
      for (uint32_t bucket = 0; bucket < buckets; ++bucket) {
        const uint64_t begin = partition.start(bucket);
        const uint64_t end = std::min(partition.end(bucket), at);
        for (uint32_t channel = 0; channel < peakChannels; ++channel)
          for (uint64_t frame = begin; frame < end; ++frame)
            foldPeak(out.peaks[bucket],
                     all[channel][static_cast<size_t>(frame)]);
      }
      finish(out, acc);
      return out;
    }

    std::vector<std::vector<float>> planes(
        channels, std::vector<float>(kBlockFrames, 0.0F));
    std::vector<float*> pointers(channels);
    for (uint32_t channel = 0; channel < channels; ++channel)
      pointers[channel] = planes[channel].data();
    uint64_t at = 0;
    uint32_t fineBucket = 0;
    uint64_t fineEnd = partition.end(0);
    while (at < frames) {
      if (cancel.isRequested()) {
        out.status = DecodedAudioStatus::Cancelled;
        return out;
      }
      size_t got = 0;
      const DecodedAudioStatus read =
          source->read(pointers.data(), kBlockFrames, &got);
      if (read != DecodedAudioStatus::Ok) {
        out.status = read;
        return out;
      }
      // A short read is the END of the source, not a failure — the last read
      // of every file returns zero.
      if (got == 0) break;
      accumulateBlock(planes, channels, at, got, cursor, acc);
      for (size_t frame = 0; frame < got; ++frame) {
        const uint64_t absolute = at + frame;
        while (fineBucket + 1 < buckets && absolute >= fineEnd) {
          ++fineBucket;
          fineEnd = partition.end(fineBucket);
        }
        for (uint32_t channel = 0; channel < peakChannels; ++channel)
          foldPeak(out.peaks[fineBucket], planes[channel][frame]);
      }
      at += got;
    }
    finish(out, acc);
    return out;
  } catch (const std::exception&) {
    out.ok = false;
    out.status = DecodedAudioStatus::ResourceExhausted;
    out.peaks.clear();
    return out;
  } catch (...) {
    out.ok = false;
    out.status = DecodedAudioStatus::ResourceExhausted;
    out.peaks.clear();
    return out;
  }
}

std::vector<LaneMeasure> measureLanes(std::vector<LaneMeasureRequest> requests,
                                      const DecodeCancellation& cancel) noexcept {
  std::vector<LaneMeasure> results(requests.size());
  std::vector<std::thread> threads;
  try {
    threads.reserve(requests.size());
  } catch (...) {
    // No room for the bookkeeping: every lane on this thread.
  }
  for (size_t index = 0; index < requests.size(); ++index) {
    bool spawned = false;
    try {
      threads.emplace_back([&results, &requests, &cancel, index] {
        results[index] = measureLane(std::move(requests[index]), cancel);
      });
      spawned = true;
    } catch (...) {
      spawned = false;
    }
    if (!spawned) results[index] = measureLane(std::move(requests[index]), cancel);
  }
  for (std::thread& thread : threads)
    if (thread.joinable()) thread.join();
  return results;
}

}  // namespace singz
