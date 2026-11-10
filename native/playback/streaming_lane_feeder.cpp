#include "streaming_lane_feeder.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <numeric>
#include <thread>

#if defined(__APPLE__)
#include <pthread.h>
#include <sys/qos.h>
#include <sys/resource.h>
#endif

namespace singz {
namespace {

bool isPowerOfTwo(uint64_t value) noexcept {
  return value != 0 && (value & (value - 1u)) == 0;
}

// One refill is bounded so a lane cannot monopolise the round: with six lanes
// the thread should visit each of them often, not fill one to the brim first.
constexpr uint64_t kRefillChunkFrames = 8192;

// The standby handshake (see Lane::stage). Two low bits of phase; every
// transition also bumps the generation above them.
constexpr uint32_t kStageIdle = 0;
constexpr uint32_t kStageArmed = 1;
constexpr uint32_t kStageSwapping = 2;  // render thread mid-swap
constexpr uint32_t kStageSwapped = 3;
constexpr uint32_t kStagePhaseMask = 3;
uint32_t stagePhase(uint32_t state) noexcept { return state & kStagePhaseMask; }
uint32_t nextStage(uint32_t state, uint32_t phase) noexcept {
  return (state & ~kStagePhaseMask) + (kStagePhaseMask + 1u) + phase;
}

// A wrap reads the loop's last frame INTERPOLATED toward the one after it, so
// a loop's fill ends this far past its end — otherwise the window's leading
// edge starves the final frame before every wrap.
constexpr uint64_t kLoopTailFrames = 2;

// A seek's stage that has not been swapped in after this long is not going to
// be: its seek was refused, superseded or landed somewhere else. Long enough
// to cover a time/pitch anchor primed after the stage and a slow callback.
constexpr auto kStageStale = std::chrono::milliseconds(1000);

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

  // Match decoded_audio's exactOutputFrames: round the resampled extent to
  // the nearest frame using integer arithmetic. Truncation made a whole-song
  // loop rounded from the measured duration exceed a streamed song by one
  // frame when 44.1 kHz stems played through a 48 kHz output.
  const uint64_t whole = info.frameCount / info.sampleRate;
  const uint64_t remainder = info.frameCount % info.sampleRate;
  if (whole > std::numeric_limits<uint64_t>::max() / outputRate)
    return DecodedAudioStatus::LimitExceeded;
  const uint64_t base = whole * outputRate;
  const uint64_t partial =
      (remainder * outputRate + info.sampleRate / 2) / info.sampleRate;
  if (base > std::numeric_limits<uint64_t>::max() - partial)
    return DecodedAudioStatus::LimitExceeded;
  const uint64_t outputFrames = base + partial;
  // Never allocate a ring larger than the song it holds. A short stem would
  // otherwise be charged for a window it can never fill, and on a lane shorter
  // than the window the ring IS the whole lane — at which point streaming
  // costs the same as decoding and should at least not cost more.
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
  lane->stats.waveformSource.store(lane->analysis != nullptr, std::memory_order_relaxed);
  lane->capacityFrames = capacity;
  // Both rings up front, in the control domain: the standby is what lets a
  // jump land on audio that is already there (see stageLane).
  for (int ring = 0; ring < 2; ++ring) {
    lane->planes[ring].assign(info.channels, std::vector<float>(capacity, 0.0F));
    lane->rings[ring].resize(info.channels);
    for (uint16_t channel = 0; channel < info.channels; ++channel)
      lane->rings[ring][channel] = lane->planes[ring][channel].data();
  }
  lane->live = 0;
  lane->window.channels = lane->rings[0].data();
  lane->windowChannels.store(lane->rings[0].data(), std::memory_order_release);
  lane->window.channelCount = info.channels;
  lane->window.capacityFrames = capacity;
  lane->sourceRate = info.sampleRate;
  lane->outputRate = outputRate;
  // Everything the window and the graph deal in is OUTPUT frames; only the
  // decoder and the waveform pass speak the file's own rate.
  lane->window.totalFrames = outputFrames;
  lane->window.sampleRate = {static_cast<double>(outputRate)};
  zdsp::streamingWindowInitialize(&lane->window, 0);

  std::lock_guard<std::mutex> lock(mutex_);
  lanes_.push_back(std::move(lane));
  return DecodedAudioStatus::Ok;
}

DecodedAudioStatus StreamingLaneGroup::prime(uint64_t requestedStart) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (lanes_.empty())
    return DecodedAudioStatus::InvalidArgument;
  for (std::unique_ptr<Lane>& holder : lanes_) {
    Lane& lane = *holder;
    // A lane shorter than the start is never read from there (its node clamps
    // to its own end), and its decoder cannot seek past its end: prime it at
    // the top rather than fail the whole group over it.
    const uint64_t startFrame =
        requestedStart < lane.window.totalFrames ? requestedStart : 0;
    // Everything about the FEEDER resets with a prime; nothing about the
    // waveform pass does. They are independent, and priming used to assign a
    // whole fresh StreamingLaneStats — which wiped the pass's fields too, and
    // is why every lane reported NO-HANDLE on a phone that plainly had
    // handles, sending one build off after a source that was never missing.
    //
    // Named one by one, and deliberately NOT as "keep a copy, blank the
    // struct, restore what matters": that shape makes the DEFAULT for every
    // field added later "silently wiped by prime()", which is this bug over
    // again. Reset what a prime actually invalidates and nothing else.
    lane.stats.refills.store(0, std::memory_order_relaxed);
    lane.stats.seeks.store(0, std::memory_order_relaxed);
    lane.stats.framesDecoded.store(0, std::memory_order_relaxed);
    lane.stats.waitedForGuard.store(0, std::memory_order_relaxed);
    lane.stats.stages.store(0, std::memory_order_relaxed);
    lane.stats.swaps.store(0, std::memory_order_relaxed);
    lane.stats.stagesAbandoned.store(0, std::memory_order_relaxed);
    // A prime happens before any block of this window runs (or after the
    // last one), so the standby handshake is simply reset: whatever was
    // staged is dropped and the window goes back to ring 0.
    lane.stage.store(nextStage(lane.stage.load(std::memory_order_acquire),
                               kStageIdle),
                     std::memory_order_release);
    lane.live = 0;
    lane.window.channels = lane.rings[0].data();
    lane.windowChannels.store(lane.rings[0].data(), std::memory_order_release);
    // starvedBlocks and ended are deliberately absent: stats() reads those
    // from the window's own atomic and from lane.ended, so resetting a copy
    // of them here only ever wrote a value nothing went on to read.
    if (!repositionDecoder(lane, startFrame))
      return DecodedAudioStatus::IoError;
    lane.residentStart = startFrame;
    lane.residentEnd = startFrame;
    lane.staleDemandValid = false;
    // Demand starts where playback will, so the first service round has
    // somewhere to chase even before a block has run.
    zdsp::streamingWindowInitialize(&lane.window, startFrame);

    const uint64_t want =
        std::min(startFrame + options_.primeFrames, lane.window.totalFrames);
    while (lane.residentEnd < want && !lane.ended.load(std::memory_order_relaxed)) {
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
  // No "this lane has ended" shortcut up here: the DEMAND is asked first,
  // always. A lane read to its end is exactly the one a singer sends back — a
  // Play after the song ran out seeks to the top of the SAME graph, a scrub
  // back out of the last seconds likewise — and a return before the seek
  // below left every lane playing silence under a metronome that went on
  // clicking. A resampled lane reaches that state on every song, because its
  // decoder hits the end of the file before the filter's flushed tail fills
  // the ring. Once the ring holds the end and nothing wants anything else,
  // the `want` test below already makes this a no-op.
  //
  // The standby handshake comes first: a ring the render thread swapped in is
  // now the live one, and everything below must be judged against it.
  const uint32_t state = lane.stage.load(std::memory_order_acquire);
  if (stagePhase(state) == kStageSwapped) {
    adoptSwap(lane, state);
    return true;
  }
  if (stagePhase(state) == kStageSwapping)
    return false;
  const bool armed = stagePhase(state) == kStageArmed;

  uint64_t demand = lane.residentStart;
  if (!zdsp::streamingWindowDemand(&lane.window, &demand))
    demand = lane.residentStart;
  // A swap moved the window to where the transport went; the demand still
  // names where it WAS until a block plays there. Chasing it would undo the
  // jump — a seek applied while paused would play its first block of silence
  // after all, and decode the old position for nothing.
  if (lane.staleDemandValid) {
    if (demand == lane.staleDemand)
      demand = lane.residentStart;
    else
      lane.staleDemandValid = false;
  }

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
    // Playback went somewhere the stage did not anticipate (a stage that
    // did hold it would have been swapped in by the transport). Take the
    // decoder back and chase it the old way. Lost to a swap that landed in
    // the meantime: adopt it and look again next round.
    if (armed && !reclaimStage(lane))
      return true;
    if (!repositionDecoder(lane, demand)) {
      lane.ended.store(true, std::memory_order_relaxed);
      return false;
    }
    lane.residentStart = demand;
    lane.residentEnd = demand;
    zdsp::streamingWindowPublishResident(&lane.window, demand, demand);
    lane.stats.seeks.fetch_add(1, std::memory_order_relaxed);
    return true;
  }

  // Inside a loop nothing past its end will ever be played before the wrap,
  // so the fill stops there — and the loop's HEAD is what the wrap needs.
  // When the live ring cannot hold it (the loop is longer than the ring, or
  // the window had already moved past it) it is staged in the standby once
  // the live ring holds everything up to the wrap, which is also the moment
  // the decoder has nothing else to do.
  const uint64_t total = lane.window.totalFrames;
  bool looping = false;
  uint64_t loopFill = total;
  if (loopEnabled_ && loopStart_ < total) {
    const uint64_t loopEnd = std::min(loopEnd_, total);
    if (demand >= loopStart_ && demand < loopEnd) {
      looping = true;
      loopFill = std::min(loopEnd + kLoopTailFrames, total);
    }
  }
  uint64_t want = std::min(demand + options_.targetAheadFrames, total);
  if (looping)
    want = std::min(want, loopFill);
  if (lane.residentEnd >= want) {
    if (!looping || lane.residentEnd < loopFill)
      return false;
    const uint64_t head = loopStart_;
    const bool headResident =
        head >= lane.residentStart &&
        (head + 1u < lane.residentEnd ||
         (head < lane.residentEnd && head + 1u >= total));
    if (headResident)
      return false;
    if (armed) {
      if (lane.stageStart.load(std::memory_order_relaxed) == head)
        return false;
      // Somebody else's stage — a seek about to land. Leave it alone unless
      // it has plainly been abandoned.
      if (std::chrono::steady_clock::now() - lane.stagedAt < kStageStale)
        return false;
      if (!reclaimStage(lane))
        return true;
    }
    return stageLane(lane, head);
  }

  // The decoder belongs to an armed stage. A seek's stage is swapped in
  // within a callback or two, and the live ring has seconds in hand, so wait
  // for it — unless the live ring is running low or the stage was abandoned.
  if (armed) {
    const uint64_t ahead =
        lane.residentEnd > demand ? lane.residentEnd - demand : 0;
    if (ahead > options_.targetAheadFrames / 4u &&
        std::chrono::steady_clock::now() - lane.stagedAt < kStageStale)
      return false;
    if (!reclaimStage(lane))
      return true;
  }
  // Staging moved the decoder; bring it back to where the live ring ends.
  if (lane.decoderAt != lane.residentEnd &&
      !repositionDecoder(lane, lane.residentEnd)) {
    lane.ended.store(true, std::memory_order_relaxed);
    return false;
  }

  // The guard: frames within safetyFrames behind the render position are never
  // overwritten, so the furthest the ring may reach is that line plus its
  // capacity. Hitting it means the feeder is ahead and should wait, not that
  // anything is wrong.
  const uint64_t guardStart =
      demand > options_.safetyFrames ? demand - options_.safetyFrames : 0;
  const uint64_t reach = guardStart + lane.window.capacityFrames;
  if (lane.residentEnd >= reach) {
    lane.stats.waitedForGuard.fetch_add(1, std::memory_order_relaxed);
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
    const uint64_t got = fillLane(lane, lane.rings[lane.live].data(), index, room);
    written += got;
    if (got < room)
      break;
  }

  lane.decoderAt += written;
  if (written == 0)
    return false;
  lane.residentEnd += written;
  lane.stats.framesDecoded.fetch_add(written, std::memory_order_relaxed);
  lane.stats.refills.fetch_add(1, std::memory_order_relaxed);
  zdsp::streamingWindowPublishResident(&lane.window, lane.residentStart,
                                       lane.residentEnd);
  return true;
}

// Restart on the global rational resampling lattice, with enough preceding
// audio to rebuild the FIR history. Flooring outputFrame * sourceRate /
// outputRate and resetting phase to zero loses its fractional input position:
// at 44.1 -> 48 kHz, seeks 256 frames apart can shift lanes by 0.2 input frames.
// An anchor at a multiple of up has an integral input position and the same
// polyphase as a continuous decode. Discard its preroll as well as the ordinary
// latency, so the ring still begins at exactly the requested output frame.
bool StreamingLaneGroup::seekLane(Lane& lane, uint64_t outputFrame) {
  lane.pending.clear();
  lane.pendingRead = 0;
  lane.dropOutputFrames = 0;
  uint64_t inputFrame = outputFrame;
  if (lane.sourceRate != lane.outputRate) {
    lane.resampler = std::make_unique<Resampler>(
        static_cast<int>(lane.sourceRate), static_cast<int>(lane.outputRate),
        static_cast<int>(lane.window.channelCount));
    const uint64_t latency =
        static_cast<uint64_t>(lane.resampler->latencyOutFrames());
    const uint32_t divisor = std::gcd(lane.sourceRate, lane.outputRate);
    const uint64_t up = lane.outputRate / divisor;
    const uint64_t down = lane.sourceRate / divisor;
    // One latency plus one output frame covers the filter's preceding input
    // support, including latencyOutFrames' integer truncation. Rounding down
    // to a lattice anchor adds fewer than up output frames: bounded by one
    // second for supported 8--192 kHz media, independent of the seek distance.
    const uint64_t periods = outputFrame > latency + 1
        ? (outputFrame - latency - 1) / up : 0;
    if (periods > std::numeric_limits<uint64_t>::max() / down)
      return false;
    inputFrame = periods * down;
    const uint64_t preroll = outputFrame - periods * up;
    if (preroll > static_cast<uint64_t>(std::numeric_limits<int64_t>::max()) - latency)
      return false;
    lane.dropOutputFrames = static_cast<int64_t>(latency + preroll);
  }
  if (lane.source->seek(inputFrame) != DecodedAudioStatus::Ok)
    return false;
  lane.stats.seeks.fetch_add(1, std::memory_order_relaxed);
  return true;
}

bool StreamingLaneGroup::repositionDecoder(Lane& lane, uint64_t outputFrame) {
  if (!seekLane(lane, outputFrame))
    return false;
  lane.decoderAt = outputFrame;
  lane.ended.store(false, std::memory_order_relaxed);
  return true;
}

// Decode the region a jump will land on into the STANDBY ring and arm it for
// the render thread. Nothing here is visible to the node until the transport
// swaps the window over, so it may take as long as the decoder needs.
// Precondition: the stage is Idle (the feeder owns both rings).
bool StreamingLaneGroup::stageLane(Lane& lane, uint64_t frame) {
  const uint64_t total = lane.window.totalFrames;
  if (frame >= total)
    return false;
  if (!repositionDecoder(lane, frame)) {
    lane.ended.store(true, std::memory_order_relaxed);
    return false;
  }
  const uint64_t capacity = lane.window.capacityFrames;
  const uint64_t span =
      std::max<uint64_t>(2, std::min(options_.stageFrames, capacity));
  const uint64_t end = std::min(frame + span, total);
  float* const* ring = lane.rings[1 - lane.live].data();
  uint64_t written = 0;
  while (frame + written < end) {
    const uint64_t at = frame + written;
    const uint64_t index = at & (capacity - 1u);
    const uint64_t room = std::min(end - at, capacity - index);
    const uint64_t got = fillLane(lane, ring, index, room);
    written += got;
    if (got < room)
      break;
  }
  lane.decoderAt = frame + written;
  if (written == 0)
    return false;
  lane.stageStart.store(frame, std::memory_order_relaxed);
  lane.stageEnd.store(frame + written, std::memory_order_relaxed);
  lane.stageChannels.store(ring, std::memory_order_relaxed);
  lane.stagedAt = std::chrono::steady_clock::now();
  // Release: the ring's contents and the three fields above are complete
  // before the render thread can see Armed.
  lane.stage.store(nextStage(lane.stage.load(std::memory_order_relaxed),
                             kStageArmed),
                   std::memory_order_release);
  lane.stats.stages.fetch_add(1, std::memory_order_relaxed);
  lane.stats.framesDecoded.fetch_add(written, std::memory_order_relaxed);
  return true;
}

bool StreamingLaneGroup::reclaimStage(Lane& lane) {
  uint32_t state = lane.stage.load(std::memory_order_acquire);
  for (;;) {
    switch (stagePhase(state)) {
      case kStageIdle:
        return true;
      case kStageArmed:
        if (lane.stage.compare_exchange_weak(
                state, nextStage(state, kStageIdle), std::memory_order_acq_rel,
                std::memory_order_acquire)) {
          lane.stats.stagesAbandoned.fetch_add(1, std::memory_order_relaxed);
          return true;
        }
        break;
      case kStageSwapping:
        // Two stores and a publish on the render thread; never long.
        std::this_thread::yield();
        state = lane.stage.load(std::memory_order_acquire);
        break;
      default:
        adoptSwap(lane, state);
        return false;
    }
  }
}

// The render thread swapped the window to the standby ring and published the
// stage as resident. That ring is the live one now; the decoder is where the
// stage left it, so ordinary refills continue from the stage's end with no
// seek at all. The ring that was live becomes the standby: the render thread
// stopped reading it the slice it swapped.
void StreamingLaneGroup::adoptSwap(Lane& lane, uint32_t state) {
  lane.live = 1 - lane.live;
  lane.residentStart = lane.stageStart.load(std::memory_order_relaxed);
  lane.residentEnd = lane.stageEnd.load(std::memory_order_relaxed);
  uint64_t demand = 0;
  lane.staleDemandValid =
      zdsp::streamingWindowDemand(&lane.window, &demand) &&
      (demand < lane.residentStart || demand >= lane.residentEnd);
  lane.staleDemand = demand;
  lane.stats.swaps.fetch_add(1, std::memory_order_relaxed);
  lane.stage.store(nextStage(state, kStageIdle), std::memory_order_release);
}

void StreamingLaneGroup::transportJumped(uint64_t sourceFrame) noexcept {
  for (const std::unique_ptr<Lane>& holder : lanes_) {
    Lane& lane = *holder;
    uint32_t state = lane.stage.load(std::memory_order_acquire);
    if (stagePhase(state) != kStageArmed)
      continue;
    const uint64_t total = lane.window.totalFrames;
    const uint64_t start = lane.stageStart.load(std::memory_order_relaxed);
    const uint64_t end = lane.stageEnd.load(std::memory_order_relaxed);
    // The node interpolates toward the next frame, so the stage must hold it
    // too — except at the very end of the song, where there is none.
    if (sourceFrame >= total || sourceFrame < start || sourceFrame >= end ||
        (sourceFrame + 1u >= end && end < total))
      continue;
    float* const* channels = lane.stageChannels.load(std::memory_order_relaxed);
    // A stage re-armed between the load above and here changed generation,
    // so this exchange fails rather than swapping in fields it did not check.
    if (!lane.stage.compare_exchange_strong(state,
                                            nextStage(state, kStageSwapping),
                                            std::memory_order_acq_rel,
                                            std::memory_order_relaxed))
      continue;
    lane.window.channels = channels;
    lane.windowChannels.store(channels, std::memory_order_release);
    zdsp::streamingWindowPublishResident(&lane.window, start, end);
    lane.stage.store(nextStage(state, kStageSwapped), std::memory_order_release);
  }
}

size_t StreamingLaneGroup::stageJump(uint64_t sourceFrame) {
  std::lock_guard<std::mutex> lock(mutex_);
  size_t staged = 0;
  for (std::unique_ptr<Lane>& holder : lanes_) {
    Lane& lane = *holder;
    const uint64_t total = lane.window.totalFrames;
    if (sourceFrame >= total)
      continue;
    // Settle the handshake: adopt a swap that already happened, and wait out
    // one that is happening.
    uint32_t state = lane.stage.load(std::memory_order_acquire);
    while (stagePhase(state) == kStageSwapping || stagePhase(state) == kStageSwapped) {
      if (stagePhase(state) == kStageSwapped)
        adoptSwap(lane, state);
      else
        std::this_thread::yield();
      state = lane.stage.load(std::memory_order_acquire);
    }
    // Already where the live ring stands, with room to carry on: the jump
    // needs nothing. "Room" allows for the refills that may still retire the
    // window's tail before the transport gets there.
    const uint64_t slack =
        lane.residentEnd - lane.residentStart + 2u * kRefillChunkFrames >
                lane.window.capacityFrames
            ? 2u * kRefillChunkFrames
            : 0u;
    const bool resident =
        sourceFrame >= lane.residentStart + slack &&
        sourceFrame + 1u < lane.residentEnd &&
        (lane.residentEnd - sourceFrame >= kRefillChunkFrames ||
         lane.residentEnd >= total);
    if (resident) {
      // A stage armed for an EARLIER seek must not be swapped in when both
      // seeks drain in one callback: it would replace the ring this one lands
      // in. Take it back.
      if (stagePhase(state) == kStageArmed)
        (void)reclaimStage(lane);
      continue;
    }
    if (stagePhase(state) == kStageArmed) {
      if (lane.stageStart.load(std::memory_order_relaxed) == sourceFrame) {
        ++staged;
        continue;
      }
      // False when the render thread swapped the old stage in after all; it
      // has been adopted, and the ring that was live is free to stage into.
      (void)reclaimStage(lane);
    }
    if (stageLane(lane, sourceFrame))
      ++staged;
  }
  wake_.notify_all();
  return staged;
}

void StreamingLaneGroup::setLoop(uint64_t startFrame, uint64_t endFrame) {
  {
    std::lock_guard<std::mutex> lock(mutex_);
    loopEnabled_ = endFrame > startFrame;
    loopStart_ = startFrame;
    loopEnd_ = endFrame;
  }
  wake_.notify_all();
}

void StreamingLaneGroup::clearLoop() {
  std::lock_guard<std::mutex> lock(mutex_);
  loopEnabled_ = false;
  loopStart_ = 0;
  loopEnd_ = 0;
}

bool StreamingLaneGroup::sampleAt(size_t index, uint32_t channel,
                                  uint64_t frame, float* value) const noexcept {
  if (index >= lanes_.size() || value == nullptr)
    return false;
  const Lane& lane = *lanes_[index];
  if (channel >= lane.window.channelCount || frame >= lane.window.totalFrames)
    return false;
  // A seqlock read over the handshake: every render-thread change to the
  // window's ring and range happens inside Swapping/Swapped and moves the
  // generation, so an unchanged Idle/Armed state on both sides means the ring
  // and the range read in between belong together.
  const uint32_t before = lane.stage.load(std::memory_order_acquire);
  if (stagePhase(before) == kStageSwapping || stagePhase(before) == kStageSwapped)
    return false;
  float* const* channels = lane.windowChannels.load(std::memory_order_acquire);
  uint64_t start = 0;
  uint64_t end = 0;
  if (channels == nullptr ||
      !zdsp::streamingWindowResident(&lane.window, &start, &end) ||
      frame < start || frame >= end)
    return false;
  const float sample =
      channels[channel][frame & (lane.window.capacityFrames - 1u)];
  std::atomic_thread_fence(std::memory_order_acquire);
  if (lane.stage.load(std::memory_order_relaxed) != before)
    return false;
  *value = sample;
  return true;
}

// Hand `frames` output frames to `ring` at `index`, decoding and resampling
// as much as that takes. Returns how many were actually placed; short means
// the lane ended.
uint64_t StreamingLaneGroup::fillLane(Lane& lane, float* const* ring,
                                      uint64_t index, uint64_t frames) {
  const uint32_t channels = lane.window.channelCount;
  if (lane.sourceRate == lane.outputRate) {
    std::vector<float*> destination(channels);
    for (uint32_t channel = 0; channel < channels; ++channel)
      destination[channel] = ring[channel] + index;
    size_t got = 0;
    const DecodedAudioStatus status =
        lane.source->read(destination.data(), static_cast<size_t>(frames), &got);
    if (status != DecodedAudioStatus::Ok)
      lane.ended.store(true, std::memory_order_relaxed);
    if (got == 0)
      lane.ended.store(true, std::memory_order_relaxed);
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
          ring[channel][index + placed + frame] =
              lane.pending[lane.pendingRead +
                           static_cast<size_t>(frame) * channels + channel];
      lane.pendingRead += static_cast<size_t>(take) * channels;
      placed += take;
      continue;
    }
    lane.pending.clear();
    lane.pendingRead = 0;
    if (lane.ended.load(std::memory_order_relaxed))
      break;

    size_t got = 0;
    const DecodedAudioStatus status =
        lane.source->read(pointers.data(), inputBlock, &got);
    if (status != DecodedAudioStatus::Ok) {
      lane.ended.store(true, std::memory_order_relaxed);
      break;
    }
    if (got == 0) {
      // End of the file: push the filter's tail through so the last frames of
      // the song are not lost to its history.
      lane.ended.store(true, std::memory_order_relaxed);
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
  // Cleared on EVERY exit from this function, so "the thread is gone" is a
  // fact the diagnostic can state rather than infer from frozen counters.
  // startWaveformPass() already set it, so the window before this line runs
  // does not read as a thread that died.
  struct AliveUntilReturn {
    std::atomic<bool>& flag;
    ~AliveUntilReturn() { flag.store(false, std::memory_order_release); }
  } aliveGuard{waveformAlive_};
  constexpr size_t kBuckets = kStreamingWaveformBuckets;
  // Read back rather than assume. A std::thread inherits the quality of
  // service of whoever created it, and on Apple a background class also drags
  // the thread's disk policy down to throttled — which the kernel implements
  // by DELAYING each read, not by using less CPU. Asking the thread what it
  // ended up with costs nothing and settles the question.
  int32_t qos = -1;
  int32_t ioPolicy = -1;
#if defined(__APPLE__)
  qos = static_cast<int32_t>(qos_class_self());
  ioPolicy = getiopolicy_np(IOPOL_TYPE_DISK, IOPOL_SCOPE_THREAD);
#endif
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
    lane.stats.waveformStarted.store(true, std::memory_order_relaxed);
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
    uint64_t readNs = 0;
    const auto laneStarted = std::chrono::steady_clock::now();
    lane.stats.waveformQos.store(qos, std::memory_order_relaxed);
    lane.stats.waveformIoPolicy.store(ioPolicy, std::memory_order_relaxed);
    size_t cursorBucket = 0;
    uint64_t cursorEnd = frames / kBuckets;
    if (cursorEnd == 0)
      cursorEnd = 1;
    while (at < frames && waveformRunning_.load(std::memory_order_acquire)) {
      size_t got = 0;
      const auto readStarted = std::chrono::steady_clock::now();
      const DecodedAudioStatus status =
          source->read(pointers.data(), block, &got);
      readNs += static_cast<uint64_t>(
          std::chrono::duration_cast<std::chrono::nanoseconds>(
              std::chrono::steady_clock::now() - readStarted)
              .count());
      if (status != DecodedAudioStatus::Ok) {
        lane.stats.waveformError.store(static_cast<uint32_t>(status), std::memory_order_relaxed);
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
      lane.stats.waveformFrames.store(at, std::memory_order_relaxed);
      lane.stats.waveformReadMs.store(readNs / 1000000, std::memory_order_relaxed);
      lane.stats.waveformElapsedMs.store(
          static_cast<uint64_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(
                  std::chrono::steady_clock::now() - laneStarted)
                  .count()),
          std::memory_order_relaxed);
    }
    if (!ok || !waveformRunning_.load(std::memory_order_acquire))
      continue;

    std::vector<float> buckets(kBuckets, 0.0F);
    for (size_t bucket = 0; bucket < kBuckets; ++bucket)
      buckets[bucket] =
          counted[bucket] == 0
              ? 0.0F
              : static_cast<float>(std::min(1.0, std::sqrt(
                    energy[bucket] / static_cast<double>(counted[bucket]))));
    {
      std::lock_guard<std::mutex> lock(mutex_);
      lane.waveformBuckets = std::move(buckets);
    }
    lane.waveformReady.store(true, std::memory_order_release);
    lane.stats.waveformDone.store(true, std::memory_order_relaxed);
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
  waveformStartedAt_ = std::chrono::steady_clock::now();
  // Set HERE rather than at the top of waveformLoop(): between creating the
  // thread and its first instruction the pass exists but has not run, and a
  // diagnostic taken in that window would report THREAD-GONE for a thread
  // that had never started.
  waveformAlive_.store(true, std::memory_order_release);
  try {
    waveformThread_ = std::thread([this] { waveformLoop(); });
  } catch (...) {
    // A machine that will not give us a thread still plays the song.
    waveformAlive_.store(false, std::memory_order_release);
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
  // Both rings: the standby is as real as the live one.
  return 2u * static_cast<size_t>(lanes_[lane]->capacityFrames) *
         lanes_[lane]->window.channelCount * sizeof(float);
}

uint64_t StreamingLaneGroup::outputFrames(size_t lane) const noexcept {
  return lane < lanes_.size() ? lanes_[lane]->window.totalFrames : 0;
}

StreamingLaneStats StreamingLaneGroup::stats(size_t lane) const noexcept {
  if (lane >= lanes_.size())
    return {};
  // A SNAPSHOT, loaded field by field. The returned struct is a plain value
  // on purpose — callers copy it around and put it in log lines — while the
  // live counters behind it are atomics, because the feeder and the waveform
  // pass write them on their own threads while this runs.
  const Lane& live = *lanes_[lane];
  StreamingLaneStats copy{};
  const auto R = std::memory_order_relaxed;
  copy.refills = live.stats.refills.load(R);
  copy.seeks = live.stats.seeks.load(R);
  copy.framesDecoded = live.stats.framesDecoded.load(R);
  copy.waitedForGuard = live.stats.waitedForGuard.load(R);
  copy.stages = live.stats.stages.load(R);
  copy.swaps = live.stats.swaps.load(R);
  copy.stagesAbandoned = live.stats.stagesAbandoned.load(R);
  copy.waveformSource = live.stats.waveformSource.load(R);
  copy.waveformStarted = live.stats.waveformStarted.load(R);
  copy.waveformDone = live.stats.waveformDone.load(R);
  copy.waveformFrames = live.stats.waveformFrames.load(R);
  copy.waveformError = live.stats.waveformError.load(R);
  copy.waveformReadMs = live.stats.waveformReadMs.load(R);
  copy.waveformElapsedMs = live.stats.waveformElapsedMs.load(R);
  copy.waveformQos = live.stats.waveformQos.load(R);
  copy.waveformIoPolicy = live.stats.waveformIoPolicy.load(R);
  copy.waveformAlive = waveformAlive_.load(std::memory_order_acquire);
  if (waveformStartedAt_.time_since_epoch().count() != 0)
    copy.waveformSinceStartMs = static_cast<uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - waveformStartedAt_)
            .count());
  copy.ended = live.ended.load(R);
  copy.starvedBlocks =
      lanes_[lane]->window.starvedBlocks.load(std::memory_order_relaxed);
  return copy;
}

}  // namespace singz
