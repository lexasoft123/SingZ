#include "streaming_lane_feeder.h"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace singz {
namespace {

bool isPowerOfTwo(uint64_t value) noexcept {
  return value != 0 && (value & (value - 1u)) == 0;
}

// One refill is bounded so a lane cannot monopolise the round: with six lanes
// the thread should visit each of them often, not fill one to the brim first.
constexpr uint64_t kRefillChunkFrames = 8192;

}  // namespace

StreamingLaneGroup::StreamingLaneGroup() = default;

StreamingLaneGroup::~StreamingLaneGroup() { stop(); }

DecodedAudioStatus StreamingLaneGroup::addLane(OwnedFileDescriptor descriptor,
                                               OwnedFileDescriptor analysis,
                                               uint32_t requiredSampleRate) {
  if (!isPowerOfTwo(options_.windowFrames))
    return DecodedAudioStatus::InvalidArgument;

  StreamingAudioOpenOptions open{};
  open.windowFrames = options_.windowFrames;
  DecodedAudioStatus status = DecodedAudioStatus::InvalidArgument;
  std::unique_ptr<StreamingAudioSource> source =
      openStreamingAudioSource(std::move(descriptor), open, &status);
  if (source == nullptr)
    return status;

  const StreamingAudioInfo& info = source->info();
  if (info.channels == 0 || info.channels > 32 || info.sampleRate == 0)
    return DecodedAudioStatus::UnsupportedFormat;
  // A lane whose file rate differs from the device's is RESAMPLED as it is
  // fed. Our own stems are 44.1 kHz and phones commonly run at 48, so this is
  // the ordinary path and not an edge case.
  const uint32_t outputRate =
      requiredSampleRate == 0 ? info.sampleRate : requiredSampleRate;

  // Never allocate a ring larger than the song it holds. A short stem would
  // otherwise be charged for a window it can never fill, and on a lane shorter
  // than the window the ring IS the whole lane — at which point streaming
  // costs the same as decoding and should at least not cost more.
  const uint64_t outputFrames =
      outputRate == info.sampleRate
          ? info.frameCount
          : static_cast<uint64_t>(static_cast<double>(info.frameCount) *
                                  static_cast<double>(outputRate) /
                                  static_cast<double>(info.sampleRate));
  uint64_t capacity = options_.windowFrames;
  if (outputFrames != 0 && outputFrames < capacity) {
    capacity = 1;
    while (capacity < outputFrames)
      capacity <<= 1;
  }

  // The waveform decoder is optional on purpose: a song that cannot open a
  // second handle still plays, it just draws no bar until something else
  // supplies one.
  DecodedAudioStatus analysisStatus = DecodedAudioStatus::InvalidArgument;
  std::unique_ptr<StreamingAudioSource> analysisSource;
  if (analysis.valid()) {
    StreamingAudioOpenOptions analysisOpen{};
    analysisSource = openStreamingAudioSource(std::move(analysis), analysisOpen,
                                              &analysisStatus);
  }

  auto lane = std::make_unique<Lane>();
  lane->source = std::move(source);
  lane->analysis = std::move(analysisSource);
  lane->capacityFrames = capacity;
  lane->planes.assign(info.channels, std::vector<float>(capacity, 0.0F));
  lane->pointers.resize(info.channels);
  for (uint16_t channel = 0; channel < info.channels; ++channel)
    lane->pointers[channel] = lane->planes[channel].data();
  lane->window.channels = lane->pointers.data();
  lane->window.channelCount = info.channels;
  lane->window.capacityFrames = capacity;
  lane->sourceRate = info.sampleRate;
  lane->outputRate = outputRate;
  // Everything the window and the graph deal in is OUTPUT frames; only the
  // decoder and the waveform pass speak the file's own rate.
  lane->window.totalFrames =
      outputRate == info.sampleRate
          ? info.frameCount
          : static_cast<uint64_t>(static_cast<double>(info.frameCount) *
                                  static_cast<double>(outputRate) /
                                  static_cast<double>(info.sampleRate));
  lane->window.sampleRate = {static_cast<double>(outputRate)};
  zdsp::streamingWindowInitialize(&lane->window, 0);

  std::lock_guard<std::mutex> lock(mutex_);
  lanes_.push_back(std::move(lane));
  return DecodedAudioStatus::Ok;
}

DecodedAudioStatus StreamingLaneGroup::prime(uint64_t startFrame) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (lanes_.empty())
    return DecodedAudioStatus::InvalidArgument;
  for (std::unique_ptr<Lane>& holder : lanes_) {
    Lane& lane = *holder;
    lane.stats = StreamingLaneStats{};
    if (!seekLane(lane, startFrame))
      return DecodedAudioStatus::IoError;
    lane.residentStart = startFrame;
    lane.residentEnd = startFrame;
    lane.ended = false;
    // Demand starts where playback will, so the first service round has
    // somewhere to chase even before a block has run.
    zdsp::streamingWindowInitialize(&lane.window, startFrame);

    const uint64_t want =
        std::min(startFrame + options_.primeFrames, lane.window.totalFrames);
    while (lane.residentEnd < want && !lane.ended) {
      const uint64_t before = lane.residentEnd;
      if (!serviceLane(lane))
        break;
      if (lane.residentEnd == before)
        break;
    }
    if (lane.residentEnd <= startFrame && lane.window.totalFrames > startFrame)
      return DecodedAudioStatus::MalformedData;
  }
  return DecodedAudioStatus::Ok;
}

// One refill for one lane. Returns true when it made progress, so the loop can
// tell a busy round from an idle one and sleep instead of spinning.
bool StreamingLaneGroup::serviceLane(Lane& lane) {
  if (lane.ended && lane.residentEnd >= lane.window.totalFrames)
    return false;

  uint64_t demand = lane.residentStart;
  if (!zdsp::streamingWindowDemand(&lane.window, &demand))
    demand = lane.residentStart;

  // A demand outside what is resident is a seek: a scrub, a loop re-anchor, or
  // the very first block. Filling forward from where the decoder happens to be
  // would deliver the wrong audio slowly; seeking delivers the right audio at
  // once.
  const bool inside = demand >= lane.residentStart && demand <= lane.residentEnd;
  const bool tooFarBehind =
      inside && lane.residentEnd > demand &&
      lane.residentEnd - demand > options_.targetAheadFrames * 4u;
  if (!inside || tooFarBehind) {
    if (demand >= lane.window.totalFrames)
      return false;
    if (!seekLane(lane, demand)) {
      lane.ended = true;
      return false;
    }
    lane.residentStart = demand;
    lane.residentEnd = demand;
    lane.ended = false;
    zdsp::streamingWindowPublishResident(&lane.window, demand, demand);
    ++lane.stats.seeks;
    return true;
  }

  const uint64_t want =
      std::min(demand + options_.targetAheadFrames, lane.window.totalFrames);
  if (lane.residentEnd >= want)
    return false;

  // The guard: frames within safetyFrames behind the render position are never
  // overwritten, so the furthest the ring may reach is that line plus its
  // capacity. Hitting it means the feeder is ahead and should wait, not that
  // anything is wrong.
  const uint64_t guardStart =
      demand > options_.safetyFrames ? demand - options_.safetyFrames : 0;
  const uint64_t reach = guardStart + lane.window.capacityFrames;
  if (lane.residentEnd >= reach) {
    ++lane.stats.waitedForGuard;
    return false;
  }

  uint64_t chunk = std::min(kRefillChunkFrames, want - lane.residentEnd);
  chunk = std::min(chunk, reach - lane.residentEnd);
  if (chunk == 0)
    return false;

  // Retire BEFORE overwriting. The frames about to be written share ring slots
  // with the oldest resident frames, so those must stop being published as
  // resident first — otherwise the render thread could still be told a frame
  // is available while it is being replaced.
  const uint64_t newEnd = lane.residentEnd + chunk;
  uint64_t newStart = lane.residentStart;
  if (newEnd - newStart > lane.window.capacityFrames)
    newStart = newEnd - lane.window.capacityFrames;
  if (newStart > lane.residentStart) {
    lane.residentStart = newStart;
    zdsp::streamingWindowPublishResident(&lane.window, newStart,
                                         lane.residentEnd);
  }

  // Fill the ring with OUTPUT frames. A chunk can straddle the wrap, so it is
  // placed in at most two contiguous pieces.
  uint64_t written = 0;
  while (written < chunk) {
    const uint64_t at = lane.residentEnd + written;
    const uint64_t index = at & (lane.window.capacityFrames - 1u);
    const uint64_t room =
        std::min(chunk - written, lane.window.capacityFrames - index);
    const uint64_t got = fillLane(lane, index, room);
    written += got;
    if (got < room)
      break;
  }

  if (written == 0)
    return false;
  lane.residentEnd += written;
  lane.stats.framesDecoded += written;
  ++lane.stats.refills;
  zdsp::streamingWindowPublishResident(&lane.window, lane.residentStart,
                                       lane.residentEnd);
  return true;
}

// Put the decoder, and the resampler with it, at an OUTPUT frame.
//
// The decoder is positioned at the corresponding INPUT frame; a fresh
// resampler follows, because its history belongs to the audio before the jump.
// Its priming delay is then dropped so the first frame handed to the ring is
// the frame that was asked for — every lane computes this the same way from
// the same rates, so lanes cannot drift apart even where the rounding is not
// exact to the sample.
bool StreamingLaneGroup::seekLane(Lane& lane, uint64_t outputFrame) {
  lane.pending.clear();
  lane.pendingRead = 0;
  lane.dropOutputFrames = 0;
  uint64_t inputFrame = outputFrame;
  if (lane.sourceRate != lane.outputRate) {
    inputFrame = static_cast<uint64_t>(static_cast<double>(outputFrame) *
                                       static_cast<double>(lane.sourceRate) /
                                       static_cast<double>(lane.outputRate));
    lane.resampler = std::make_unique<Resampler>(
        static_cast<int>(lane.sourceRate), static_cast<int>(lane.outputRate),
        static_cast<int>(lane.window.channelCount));
    lane.dropOutputFrames = lane.resampler->latencyOutFrames();
  }
  if (lane.source->seek(inputFrame) != DecodedAudioStatus::Ok)
    return false;
  ++lane.stats.seeks;
  return true;
}

// Hand `frames` output frames to the ring at `index`, decoding and resampling
// as much as that takes. Returns how many were actually placed; short means
// the lane ended.
uint64_t StreamingLaneGroup::fillLane(Lane& lane, uint64_t index,
                                      uint64_t frames) {
  const uint32_t channels = lane.window.channelCount;
  if (lane.sourceRate == lane.outputRate) {
    std::vector<float*> destination(channels);
    for (uint32_t channel = 0; channel < channels; ++channel)
      destination[channel] = lane.pointers[channel] + index;
    size_t got = 0;
    const DecodedAudioStatus status =
        lane.source->read(destination.data(), static_cast<size_t>(frames), &got);
    if (status != DecodedAudioStatus::Ok)
      lane.ended = true;
    if (got == 0)
      lane.ended = true;
    return got;
  }

  const size_t inputBlock = 4096;
  if (lane.decodePlanes.size() != channels) {
    lane.decodePlanes.assign(channels, std::vector<float>(inputBlock, 0.0F));
    lane.decodePointers.resize(channels);
    for (uint32_t channel = 0; channel < channels; ++channel)
      lane.decodePointers[channel] = lane.decodePlanes[channel].data();
  }
  std::vector<std::vector<float>>& planes = lane.decodePlanes;
  std::vector<float*>& pointers = lane.decodePointers;
  std::vector<float>& interleaved = lane.interleaved;

  uint64_t placed = 0;
  while (placed < frames) {
    // Drain whatever the resampler already produced before asking for more.
    const size_t availableFrames =
        (lane.pending.size() - lane.pendingRead) / channels;
    if (availableFrames != 0) {
      if (lane.dropOutputFrames > 0) {
        const uint64_t drop = std::min<uint64_t>(
            static_cast<uint64_t>(lane.dropOutputFrames), availableFrames);
        lane.pendingRead += static_cast<size_t>(drop) * channels;
        lane.dropOutputFrames -= static_cast<int64_t>(drop);
        continue;
      }
      const uint64_t take = std::min<uint64_t>(frames - placed, availableFrames);
      for (uint64_t frame = 0; frame < take; ++frame)
        for (uint32_t channel = 0; channel < channels; ++channel)
          lane.pointers[channel][index + placed + frame] =
              lane.pending[lane.pendingRead +
                           static_cast<size_t>(frame) * channels + channel];
      lane.pendingRead += static_cast<size_t>(take) * channels;
      placed += take;
      continue;
    }
    lane.pending.clear();
    lane.pendingRead = 0;
    if (lane.ended)
      break;

    size_t got = 0;
    const DecodedAudioStatus status =
        lane.source->read(pointers.data(), inputBlock, &got);
    if (status != DecodedAudioStatus::Ok) {
      lane.ended = true;
      break;
    }
    if (got == 0) {
      // End of the file: push the filter's tail through so the last frames of
      // the song are not lost to its history.
      lane.ended = true;
      if (lane.resampler != nullptr)
        lane.resampler->flush(lane.pending);
      if (lane.pending.empty())
        break;
      continue;
    }
    interleaved.resize(static_cast<size_t>(got) * channels);
    for (size_t frame = 0; frame < got; ++frame)
      for (uint32_t channel = 0; channel < channels; ++channel)
        interleaved[frame * channels + channel] = planes[channel][frame];
    lane.resampler->process(interleaved.data(), static_cast<int64_t>(got),
                            lane.pending);
  }
  return placed;
}

bool StreamingLaneGroup::serviceOnceForTesting() {
  std::lock_guard<std::mutex> lock(mutex_);
  bool progressed = false;
  for (std::unique_ptr<Lane>& lane : lanes_)
    progressed = serviceLane(*lane) || progressed;
  return progressed;
}

// One linear pass per lane, off the feeder thread and off the render thread.
//
// The bucket boundaries come from the container's frame count, so they match
// the decoded path's exactly; the arithmetic is the same RMS over every
// channel. Summation ORDER differs — this accumulates frame by frame where the
// decoded pass goes channel by channel — so the two agree to floating-point
// rounding rather than bit for bit, which is far below what a drawn bar can
// show.
void StreamingLaneGroup::waveformLoop() {
  constexpr size_t kBuckets = kStreamingWaveformBuckets;
  for (size_t index = 0; index < lanes_.size(); ++index) {
    if (!waveformRunning_.load(std::memory_order_acquire))
      return;
    Lane& lane = *lanes_[index];
    // Already measured — by a previous generation of this song, handed over
    // when the graph was rebuilt. Measuring it again would cost seconds and
    // produce the same numbers.
    if (lane.waveformReady.load(std::memory_order_acquire))
      continue;
    StreamingAudioSource* source = lane.analysis.get();
    if (source == nullptr)
      continue;
    const uint64_t frames = source->info().frameCount;
    const uint16_t channels = source->info().channels;
    if (frames == 0 || channels == 0)
      continue;

    std::vector<double> energy(kBuckets, 0.0);
    std::vector<uint64_t> counted(kBuckets, 0);
    const size_t block = 16384;
    std::vector<std::vector<float>> planes(channels,
                                           std::vector<float>(block, 0.0F));
    std::vector<float*> pointers(channels);
    for (uint16_t channel = 0; channel < channels; ++channel)
      pointers[channel] = planes[channel].data();

    uint64_t at = 0;
    bool ok = true;
    size_t cursorBucket = 0;
    uint64_t cursorEnd = frames / kBuckets;
    if (cursorEnd == 0)
      cursorEnd = 1;
    while (at < frames && waveformRunning_.load(std::memory_order_acquire)) {
      size_t got = 0;
      const DecodedAudioStatus status =
          source->read(pointers.data(), block, &got);
      if (status != DecodedAudioStatus::Ok) {
        ok = false;
        break;
      }
      // A short read is the END of the source, not a failure — and treating it
      // as one threw away every completed pass, because the last read of every
      // file returns zero.
      if (got == 0)
        break;
      for (size_t frame = 0; frame < got; ++frame) {
        const uint64_t absolute = at + frame;
        // The SAME partition the decoded summary uses, walked forward: bucket
        // b is [b*frames/buckets, (b+1)*frames/buckets). Deriving the bucket
        // from the frame instead (frame*buckets/frames) is the same partition
        // only in real arithmetic — integer division moves a frame or two at
        // each edge, which measured as a 4e-5 disagreement between the two
        // pictures. Small, and avoidable for nothing.
        while (cursorBucket + 1 < kBuckets && absolute >= cursorEnd) {
          ++cursorBucket;
          cursorEnd = (cursorBucket + 1) * frames / kBuckets;
          if (cursorEnd <= cursorBucket * frames / kBuckets)
            cursorEnd = cursorBucket * frames / kBuckets + 1;
        }
        const size_t bucket = cursorBucket;
        for (uint16_t channel = 0; channel < channels; ++channel) {
          const float sample = planes[channel][frame];
          if (!std::isfinite(sample))
            continue;
          energy[bucket] +=
              static_cast<double>(sample) * static_cast<double>(sample);
          ++counted[bucket];
        }
      }
      at += got;
    }
    if (!ok || !waveformRunning_.load(std::memory_order_acquire))
      continue;

    std::vector<float> buckets(kBuckets, 0.0F);
    for (size_t bucket = 0; bucket < kBuckets; ++bucket)
      buckets[bucket] =
          counted[bucket] == 0
              ? 0.0F
              : static_cast<float>(std::sqrt(
                    energy[bucket] / static_cast<double>(counted[bucket])));
    {
      std::lock_guard<std::mutex> lock(mutex_);
      lane.waveformBuckets = std::move(buckets);
    }
    lane.waveformReady.store(true, std::memory_order_release);
  }
}

void StreamingLaneGroup::seedWaveform(size_t lane, const float* buckets,
                                      size_t bucketCount) {
  if (lane >= lanes_.size() || buckets == nullptr ||
      bucketCount != kStreamingWaveformBuckets)
    return;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    lanes_[lane]->waveformBuckets.assign(buckets, buckets + bucketCount);
  }
  lanes_[lane]->waveformReady.store(true, std::memory_order_release);
}

void StreamingLaneGroup::startWaveformPass() {
  if (waveformRunning_.exchange(true, std::memory_order_acq_rel))
    return;
  try {
    waveformThread_ = std::thread([this] { waveformLoop(); });
  } catch (...) {
    // A machine that will not give us a thread still plays the song.
    waveformRunning_.store(false, std::memory_order_release);
  }
}

bool StreamingLaneGroup::waveform(size_t lane, float* buckets,
                                  size_t bucketCount) const noexcept {
  if (lane >= lanes_.size() || buckets == nullptr ||
      bucketCount != kStreamingWaveformBuckets ||
      !lanes_[lane]->waveformReady.load(std::memory_order_acquire))
    return false;
  std::lock_guard<std::mutex> lock(mutex_);
  if (lanes_[lane]->waveformBuckets.size() != bucketCount)
    return false;
  for (size_t index = 0; index < bucketCount; ++index)
    buckets[index] = lanes_[lane]->waveformBuckets[index];
  return true;
}

bool StreamingLaneGroup::waveformComplete() const noexcept {
  for (const std::unique_ptr<Lane>& lane : lanes_)
    if (lane->analysis != nullptr &&
        !lane->waveformReady.load(std::memory_order_acquire))
      return false;
  return true;
}

void StreamingLaneGroup::loop() {
  while (running_.load(std::memory_order_acquire)) {
    bool progressed = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      for (std::unique_ptr<Lane>& lane : lanes_)
        progressed = serviceLane(*lane) || progressed;
    }
    if (progressed)
      continue;
    // Nothing to do: every lane is as far ahead as it is allowed to be. Wake
    // on a timer rather than spin, and short enough that a scrub is chased
    // within a block or two.
    std::unique_lock<std::mutex> lock(mutex_);
    wake_.wait_for(lock, std::chrono::milliseconds(4));
  }
}

void StreamingLaneGroup::start() {
  if (running_.exchange(true, std::memory_order_acq_rel))
    return;
  thread_ = std::thread([this] { loop(); });
}

void StreamingLaneGroup::stop() {
  // The waveform pass is stopped first and unconditionally: it may be running
  // even when the feeder never started, and it holds the lane storage the
  // destructor is about to take away.
  waveformRunning_.store(false, std::memory_order_release);
  if (waveformThread_.joinable())
    waveformThread_.join();
  if (!running_.exchange(false, std::memory_order_acq_rel))
    return;
  wake_.notify_all();
  if (thread_.joinable())
    thread_.join();
}

zdsp::StreamingWindow* StreamingLaneGroup::window(size_t lane) noexcept {
  return lane < lanes_.size() ? &lanes_[lane]->window : nullptr;
}

const StreamingAudioInfo* StreamingLaneGroup::info(size_t lane) const noexcept {
  return lane < lanes_.size() ? &lanes_[lane]->source->info() : nullptr;
}

size_t StreamingLaneGroup::retainedBytes(size_t lane) const noexcept {
  if (lane >= lanes_.size())
    return 0;
  return static_cast<size_t>(lanes_[lane]->capacityFrames) *
         lanes_[lane]->window.channelCount * sizeof(float);
}

uint64_t StreamingLaneGroup::outputFrames(size_t lane) const noexcept {
  return lane < lanes_.size() ? lanes_[lane]->window.totalFrames : 0;
}

StreamingLaneStats StreamingLaneGroup::stats(size_t lane) const noexcept {
  if (lane >= lanes_.size())
    return {};
  StreamingLaneStats copy = lanes_[lane]->stats;
  copy.ended = lanes_[lane]->ended;
  copy.starvedBlocks =
      lanes_[lane]->window.starvedBlocks.load(std::memory_order_relaxed);
  return copy;
}

}  // namespace singz
