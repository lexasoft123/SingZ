#include "presentation_history.h"

#include <cmath>

namespace singz {
namespace {
constexpr auto relaxed = std::memory_order_relaxed;
static_assert(std::atomic<uint64_t>::is_always_lock_free &&
              std::atomic<uint32_t>::is_always_lock_free &&
              std::atomic<double>::is_always_lock_free,
              "Presentation journal payloads must never acquire a lock");
}

void PlaybackPresentationHistory::AtomicEntry::store(
    const PlaybackPresentationEntry &e, uint64_t token) noexcept {
  host.store(e.hostTimeNs, relaxed);
  frames.store(e.frames, relaxed);
  sampleRate.store(e.sampleRate, relaxed);
  project.store(e.projectFrame, relaxed);
  rate.store(e.rate, relaxed);
  transpose.store(e.transposeSemitones, relaxed);
  generation.store(e.generation, relaxed);
  continuous.store(e.continuousFrame, relaxed);
  seeks.store(e.seekCount, relaxed);
  loops.store(e.loopCount, relaxed);
  flags.store((e.paused ? 1u : 0u) | (e.nonAffine ? 2u : 0u), relaxed);
  serial.store(token, relaxed);
}

PlaybackPresentationEntry
PlaybackPresentationHistory::AtomicEntry::load() const noexcept {
  PlaybackPresentationEntry e;
  e.hostTimeNs = host.load(relaxed);
  e.frames = frames.load(relaxed);
  e.sampleRate = sampleRate.load(relaxed);
  e.projectFrame = project.load(relaxed);
  e.rate = rate.load(relaxed);
  e.transposeSemitones = transpose.load(relaxed);
  e.generation = generation.load(relaxed);
  e.continuousFrame = continuous.load(relaxed);
  e.seekCount = seeks.load(relaxed);
  e.loopCount = loops.load(relaxed);
  const auto f = flags.load(relaxed);
  e.paused = (f & 1u) != 0;
  e.nonAffine = (f & 2u) != 0;
  return e;
}

bool PlaybackPresentationHistory::append(
    const PlaybackPresentationEntry &e) noexcept {
  if (!e.hostTimeNs || !e.frames || !e.generation ||
      !std::isfinite(e.sampleRate) || e.sampleRate <= 0 ||
      !std::isfinite(e.projectFrame) || !std::isfinite(e.rate) || e.rate < 0 ||
      !std::isfinite(e.transposeSemitones))
    return false;
  // A host clock restart discards old coverage; a query must not binary-search
  // an unordered ring or reuse a preceding clock incarnation.
  const bool clockRestart = writerCount_ && e.hostTimeNs <= previous_.hostTimeNs;
  const bool freshTimeline = writerCount_ && e.generation != previous_.generation &&
      e.continuousFrame <= previous_.continuousFrame;
  const bool boundary = writerCount_ &&
      (e.seekCount != previous_.seekCount || e.loopCount != previous_.loopCount);
  const bool generationChange = writerCount_ && e.generation != previous_.generation;
  const bool pauseChange = writerCount_ && e.paused != previous_.paused;
  // A settings seam adopts the continuous clock and source coordinate. Never
  // excuse seek/loop, restart, pause or an interior non-affine callback merely
  // because it happened to share a generation change.
  const double expected = previous_.projectFrame +
      double(e.continuousFrame - previous_.continuousFrame) * previous_.rate;
  const bool affineSeam = generationChange && !clockRestart && !freshTimeline &&
      !boundary && !pauseChange && !e.nonAffine && !previous_.nonAffine &&
      (e.rate != previous_.rate || e.transposeSemitones != previous_.transposeSemitones) &&
      e.sampleRate == previous_.sampleRate &&
      std::abs(e.projectFrame - expected) < 1.0;
  const bool fault = clockRestart || freshTimeline || boundary || e.nonAffine ||
      pauseChange || (generationChange && !affineSeam);
  if (fault || generationChange)
    ++writerSerial_;
  if (fault) ++writerFaultSerial_;
  if (!writerCount_ || fault || generationChange || e.rate != previous_.rate) {
    mappingHost_ = e.hostTimeNs;
    mappingSeconds_ = e.projectFrame / e.sampleRate;
  }
  sequence_.fetch_add(1, std::memory_order_acq_rel);
  if (clockRestart || freshTimeline) writerHead_ = writerCount_ = 0;
  if (writerCount_ == kCapacity) {
    writerHead_ = (writerHead_ + 1) % kCapacity;
    --writerCount_;
  }
  entries_[(writerHead_ + writerCount_) % kCapacity].store(e, writerSerial_);
  auto &added = entries_[(writerHead_ + writerCount_) % kCapacity];
  added.faultSerial.store(writerFaultSerial_, relaxed);
  added.mappingHost.store(mappingHost_, relaxed);
  added.mappingSeconds.store(mappingSeconds_, relaxed);
  ++writerCount_;
  head_.store(writerHead_, relaxed);
  count_.store(writerCount_, relaxed);
  sequence_.fetch_add(1, std::memory_order_release);
  previous_ = e;
  return true;
}

PlaybackPresentationQuery
PlaybackPresentationHistory::query(uint64_t hostTimeNs) const noexcept {
  if (!hostTimeNs) return {};
  for (unsigned attempt = 0; attempt < 8; ++attempt) {
    const auto before = sequence_.load(std::memory_order_acquire);
    if (before & 1u) continue;
    const auto head = head_.load(relaxed), count = count_.load(relaxed);
    uint32_t lo = 0, hi = count;
    // Last callback beginning at/before target; an exact edge belongs to the
    // succeeding callback, so pause/rate/seek changes have their correct owner.
    while (lo < hi) {
      const auto mid = lo + (hi - lo) / 2;
      if (entries_[(head + mid) % kCapacity].host.load(relaxed) <= hostTimeNs)
        lo = mid + 1;
      else hi = mid;
    }
    PlaybackPresentationQuery result;
    if (count) result.latestGeneration =
        entries_[(head + count - 1) % kCapacity].generation.load(relaxed);
    if (lo) {
      const auto &slot = entries_[(head + lo - 1) % kCapacity];
      const auto e = slot.load();
      const long double offset =
          static_cast<long double>(hostTimeNs - e.hostTimeNs) * e.sampleRate / 1.e9L;
      if (offset >= 0 && offset < e.frames) {
        result.generation = e.generation;
        result.discontinuitySerial = slot.serial.load(relaxed);
        result.faultSerial = slot.faultSerial.load(relaxed);
        result.mappingStartHostNs = slot.mappingHost.load(relaxed);
        result.mappingStartSongSeconds = slot.mappingSeconds.load(relaxed);
        result.nonAffine = e.nonAffine;
        result.paused = e.paused;
        result.sampleRate = e.sampleRate;
        result.rate = e.rate;
        result.transposeSemitones = e.transposeSemitones;
        if (!e.nonAffine) {
          result.projectFrame = static_cast<double>(e.projectFrame + offset * e.rate);
          result.songSeconds = result.projectFrame / e.sampleRate;
          result.found = std::isfinite(result.projectFrame);
        }
      }
    }
    std::atomic_thread_fence(std::memory_order_acquire);
    if (before == sequence_.load(std::memory_order_acquire)) return result;
  }
  return {};
}
} // namespace singz
