#include "streaming_lane_feeder.h"

#include <algorithm>
#include <chrono>

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
  // The streaming source does not resample. A lane that disagrees with the
  // device is refused here, because the alternative is playing it at the wrong
  // speed and calling that success.
  if (requiredSampleRate != 0 && info.sampleRate != requiredSampleRate)
    return DecodedAudioStatus::UnsupportedFormat;

  // Never allocate a ring larger than the song it holds. A short stem would
  // otherwise be charged for a window it can never fill, and on a lane shorter
  // than the window the ring IS the whole lane — at which point streaming
  // costs the same as decoding and should at least not cost more.
  uint64_t capacity = options_.windowFrames;
  if (info.frameCount != 0 && info.frameCount < capacity) {
    capacity = 1;
    while (capacity < info.frameCount)
      capacity <<= 1;
  }

  auto lane = std::make_unique<Lane>();
  lane->source = std::move(source);
  lane->capacityFrames = capacity;
  lane->planes.assign(info.channels, std::vector<float>(capacity, 0.0F));
  lane->pointers.resize(info.channels);
  for (uint16_t channel = 0; channel < info.channels; ++channel)
    lane->pointers[channel] = lane->planes[channel].data();
  lane->window.channels = lane->pointers.data();
  lane->window.channelCount = info.channels;
  lane->window.capacityFrames = capacity;
  lane->window.totalFrames = info.frameCount;
  lane->window.sampleRate = {static_cast<double>(info.sampleRate)};
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
    const DecodedAudioStatus status = lane.source->seek(startFrame);
    if (status != DecodedAudioStatus::Ok)
      return status;
    lane.residentStart = startFrame;
    lane.residentEnd = startFrame;
    lane.ended = false;
    lane.stats = StreamingLaneStats{};
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
    const DecodedAudioStatus status = lane.source->seek(demand);
    if (status != DecodedAudioStatus::Ok) {
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

  // The decoder is positioned at residentEnd by construction: every refill
  // appends, and every jump seeks and resets the range.
  if (lane.source->position() != lane.residentEnd) {
    const DecodedAudioStatus status = lane.source->seek(lane.residentEnd);
    if (status != DecodedAudioStatus::Ok) {
      lane.ended = true;
      return false;
    }
    ++lane.stats.seeks;
  }

  // Decode straight into the ring. A chunk can straddle the wrap, so it is
  // decoded in at most two pieces, each contiguous.
  uint64_t written = 0;
  while (written < chunk) {
    const uint64_t at = lane.residentEnd + written;
    const uint64_t index = at & (lane.window.capacityFrames - 1u);
    const uint64_t room =
        std::min(chunk - written, lane.window.capacityFrames - index);
    std::vector<float*> destination(lane.pointers.size());
    for (size_t channel = 0; channel < lane.pointers.size(); ++channel)
      destination[channel] = lane.pointers[channel] + index;
    size_t got = 0;
    const DecodedAudioStatus status = lane.source->read(
        destination.data(), static_cast<size_t>(room), &got);
    written += got;
    if (status != DecodedAudioStatus::Ok || got == 0) {
      if (status != DecodedAudioStatus::Ok)
        lane.ended = true;
      if (got == 0) {
        lane.ended = true;
        break;
      }
      break;
    }
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

bool StreamingLaneGroup::serviceOnceForTesting() {
  std::lock_guard<std::mutex> lock(mutex_);
  bool progressed = false;
  for (std::unique_ptr<Lane>& lane : lanes_)
    progressed = serviceLane(*lane) || progressed;
  return progressed;
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
