#pragma once

#include <array>
#include <atomic>
#include <cstdint>

namespace singz {

// A terminal cause is stamped at the producer, not when a control thread next
// samples status. The process-wide ordinal lets independent lock-free domains
// (platform notification, hardware callback, graph callback and provider)
// retain the actual first publication even if several causes arrive before a
// status sampling. The ordinal cannot wrap during any realistic process
// lifetime; once saturated, an already-latched cause remains authoritative.
enum class AudioHostTerminalReason : uint32_t {
  None = 0,
  RouteChanged,
  Interrupted,
  MediaServicesLost,
  MediaServicesReset,
  DeviceLost,
  ProviderFailure,
};

struct AudioHostTerminalCause {
  AudioHostTerminalReason reason{AudioHostTerminalReason::None};
  uint64_t ordinal{0};
};

enum class AudioHostTerminalProducer : uint32_t {
  PlatformNotification = 0,
  HostCallback,
  Provider,
  GraphCallback,
  ControlRetained,
  Test,
  Count,
};

// The ordinal allocator uses one wait-free fetch-add on the ordinary path.
// A reserved tail prevents an already-admitted set of publishers from ever
// wrapping while one of them publishes the process-wide saturation flag.
// Production has one serialized writer per producer domain; 64 is therefore
// a deliberately conservative bound that also covers deterministic stress
// fixtures and notification/callback overlap during teardown.
inline constexpr uint32_t kAudioHostTerminalMaximumConcurrentPublishers = 64;
inline constexpr uint32_t kAudioHostTerminalOrdinalReasonBits = 3;
inline constexpr uint64_t kAudioHostTerminalMaximumOrdinal =
    UINT64_MAX >> kAudioHostTerminalOrdinalReasonBits;
inline constexpr uint64_t kAudioHostTerminalOrdinalSaturationBoundary =
    kAudioHostTerminalMaximumOrdinal -
    kAudioHostTerminalMaximumConcurrentPublishers;
inline constexpr uint32_t kAudioHostTerminalRetainAttempts =
    kAudioHostTerminalMaximumConcurrentPublishers;
// Kept as a named stress threshold: tests deliberately publish more than the
// former fixed journal capacity to prove that no event is discarded there.
inline constexpr uint32_t kAudioHostTerminalSlotsPerProducer = 4;
inline std::atomic<uint64_t> gAudioHostTerminalOrdinal{0};
inline std::atomic<bool> gAudioHostTerminalOrdinalSaturated{false};
inline std::atomic<uint32_t> gAudioHostTerminalOrdinalPublishers{0};
inline std::atomic<bool> gAudioHostTerminalOrdinalConcurrencyViolated{false};

static_assert(static_cast<uint32_t>(AudioHostTerminalReason::ProviderFailure) <
              (1u << kAudioHostTerminalOrdinalReasonBits));
static_assert(kAudioHostTerminalMaximumConcurrentPublishers >
              static_cast<uint32_t>(AudioHostTerminalProducer::Count));

namespace detail {

inline bool tryAdmitAudioHostTerminalPublisher(
    std::atomic<uint32_t>& active) noexcept {
  uint32_t observed = active.load(std::memory_order_acquire);
  for (uint32_t attempt = 0;
       attempt < kAudioHostTerminalMaximumConcurrentPublishers; ++attempt) {
    if (observed >= kAudioHostTerminalMaximumConcurrentPublishers)
      return false;
    if (active.compare_exchange_strong(
            observed, observed + 1, std::memory_order_acq_rel,
            std::memory_order_acquire))
      return true;
  }
  // A bounded admission failure is handled exactly like an exhausted
  // publisher budget by the caller. Unlike fetch-add/rollback, this path can
  // never transiently wrap a corrupted or saturated counter through zero.
  return false;
}

inline void releaseAudioHostTerminalPublisher(
    std::atomic<uint32_t>& active) noexcept {
  active.fetch_sub(1, std::memory_order_release);
}

inline uint64_t packAudioHostTerminalCause(
    AudioHostTerminalCause cause) noexcept {
  const uint64_t ordinal =
      cause.ordinal <= kAudioHostTerminalMaximumOrdinal
          ? cause.ordinal
          : kAudioHostTerminalMaximumOrdinal;
  uint32_t reason = static_cast<uint32_t>(cause.reason);
  if (reason == 0 ||
      reason >= (1u << kAudioHostTerminalOrdinalReasonBits))
    reason = static_cast<uint32_t>(
        AudioHostTerminalReason::ProviderFailure);
  return (ordinal << kAudioHostTerminalOrdinalReasonBits) | reason;
}

inline AudioHostTerminalCause unpackAudioHostTerminalCause(
    uint64_t packed) noexcept {
  if (packed == 0) return {};
  return {static_cast<AudioHostTerminalReason>(
              packed & ((1u << kAudioHostTerminalOrdinalReasonBits) - 1u)),
          packed >> kAudioHostTerminalOrdinalReasonBits};
}

inline bool packedCausePrecedes(uint64_t packed,
                                AudioHostTerminalCause candidate) noexcept {
  return packed != 0 &&
      unpackAudioHostTerminalCause(packed).ordinal <= candidate.ordinal;
}

// This is factored so policy tests can deterministically pre-admit the full
// publisher budget and exercise the exact fail-closed path used by the latch.
// The overflow cell is not a diagnostic bit: it is a coherent cause record
// included in current()/hasCause(), so a rejected 65th publisher is visible
// immediately even while every admitted publisher is paused before publish.
inline void retainAudioHostTerminalCause(
    AudioHostTerminalCause candidate, std::atomic<uint64_t>& earliest,
    std::atomic<uint64_t>& overflow, std::atomic<uint32_t>& active,
    std::atomic<bool>& concurrencyBoundViolated) noexcept {
  if (candidate.reason == AudioHostTerminalReason::None ||
      candidate.ordinal == 0)
    return;
  const uint64_t packed = packAudioHostTerminalCause(candidate);
  if (!tryAdmitAudioHostTerminalPublisher(active)) {
    concurrencyBoundViolated.store(true, std::memory_order_release);
    uint64_t observed = overflow.load(std::memory_order_acquire);
    for (uint32_t attempt = 0;
         attempt < kAudioHostTerminalRetainAttempts; ++attempt) {
      if (packedCausePrecedes(observed, candidate)) return;
      if (overflow.compare_exchange_strong(
              observed, packed, std::memory_order_release,
              std::memory_order_acquire))
        return;
    }
    // Strong-CAS failures mean another rejected writer published a coherent
    // fallback. Do not spin on the callback thread; that visible record keeps
    // the latch fail-closed even if exact minimum replacement was contended.
    return;
  }
  uint64_t observed = earliest.load(std::memory_order_acquire);
  for (uint32_t attempt = 0;
       attempt < kAudioHostTerminalRetainAttempts; ++attempt) {
    if (packedCausePrecedes(observed, candidate)) {
      releaseAudioHostTerminalPublisher(active);
      return;
    }
    if (earliest.compare_exchange_strong(
            observed, packed, std::memory_order_release,
            std::memory_order_acquire)) {
      releaseAudioHostTerminalPublisher(active);
      return;
    }
  }
  concurrencyBoundViolated.store(true, std::memory_order_release);
  releaseAudioHostTerminalPublisher(active);
}

}  // namespace detail

inline AudioHostTerminalCause makeAudioHostTerminalCause(
    AudioHostTerminalReason reason) noexcept {
  if (reason == AudioHostTerminalReason::None) return {};
  if (gAudioHostTerminalOrdinalSaturated.load(std::memory_order_acquire))
    return {reason, kAudioHostTerminalMaximumOrdinal};
  if (!detail::tryAdmitAudioHostTerminalPublisher(
          gAudioHostTerminalOrdinalPublishers)) {
    // A caller exceeded the enforced in-flight budget. Fail this event to the
    // latest possible ordinal without saturating the process epoch: temporary
    // contention must not destroy future-session ordering.
    gAudioHostTerminalOrdinalConcurrencyViolated.store(
        true, std::memory_order_release);
    return {reason, kAudioHostTerminalMaximumOrdinal};
  }
  const uint64_t observed =
      gAudioHostTerminalOrdinal.load(std::memory_order_relaxed);
  if (observed >= kAudioHostTerminalOrdinalSaturationBoundary) {
    gAudioHostTerminalOrdinalSaturated.store(true,
                                             std::memory_order_release);
    detail::releaseAudioHostTerminalPublisher(
        gAudioHostTerminalOrdinalPublishers);
    return {reason, kAudioHostTerminalMaximumOrdinal};
  }
  const uint64_t previous =
      gAudioHostTerminalOrdinal.fetch_add(1, std::memory_order_relaxed);
  // Publishers that observed the ordinary range before another publisher
  // crossed the boundary may consume only the reserved headroom. The
  // documented concurrency bound guarantees this addition cannot wrap.
  if (previous >= kAudioHostTerminalOrdinalSaturationBoundary) {
    gAudioHostTerminalOrdinalSaturated.store(true,
                                             std::memory_order_release);
    const uint64_t ordinal =
        previous < kAudioHostTerminalMaximumOrdinal
            ? previous + 1
            : kAudioHostTerminalMaximumOrdinal;
    detail::releaseAudioHostTerminalPublisher(
        gAudioHostTerminalOrdinalPublishers);
    return {reason, ordinal};
  }
  detail::releaseAudioHostTerminalPublisher(
      gAudioHostTerminalOrdinalPublishers);
  return {reason, previous + 1};
}

inline AudioHostTerminalCause firstAudioHostTerminalCause(
    AudioHostTerminalCause left, AudioHostTerminalCause right) noexcept {
  if (left.reason == AudioHostTerminalReason::None) return right;
  if (right.reason == AudioHostTerminalReason::None) return left;
  if (left.ordinal == 0) return right.ordinal == 0 ? left : right;
  if (right.ordinal == 0) return left;
  return left.ordinal <= right.ordinal ? left : right;
}

class AudioHostTerminalCauseLatch final {
 public:
  AudioHostTerminalCause publish(
      AudioHostTerminalReason reason,
      AudioHostTerminalProducer producer) noexcept {
    const uint32_t producerIndex = index(producer);
    const AudioHostTerminalCause existing = currentFor(producerIndex);
    if (existing.reason != AudioHostTerminalReason::None) return current();
    const AudioHostTerminalCause candidate =
        makeAudioHostTerminalCause(reason);
    retain(candidate, producer);
    return current();
  }

  void retain(AudioHostTerminalCause candidate,
              AudioHostTerminalProducer producer) noexcept {
    const uint32_t producerIndex = index(producer);
    detail::retainAudioHostTerminalCause(
        candidate, earliest_[producerIndex], overflow_[producerIndex],
        activeRetainers_[producerIndex],
        concurrencyBoundViolated_[producerIndex]);
  }

  [[nodiscard]] AudioHostTerminalCause current() const noexcept {
    AudioHostTerminalCause result{};
    for (uint32_t producer = 0; producer < kProducerCount; ++producer) {
      result = firstAudioHostTerminalCause(result, currentFor(producer));
    }
    return result;
  }

  [[nodiscard]] bool hasCause() const noexcept {
    for (uint32_t producer = 0; producer < kProducerCount; ++producer) {
      if (earliest_[producer].load(std::memory_order_acquire) != 0 ||
          overflow_[producer].load(std::memory_order_acquire) != 0)
        return true;
    }
    return false;
  }

  void reset() noexcept {
    for (uint32_t producer = 0; producer < kProducerCount; ++producer) {
      earliest_[producer].store(0, std::memory_order_relaxed);
      overflow_[producer].store(0, std::memory_order_relaxed);
      activeRetainers_[producer].store(0, std::memory_order_relaxed);
      concurrencyBoundViolated_[producer].store(false,
                                                 std::memory_order_relaxed);
    }
  }

  [[nodiscard]] bool concurrencyBoundViolated() const noexcept {
    for (uint32_t producer = 0; producer < kProducerCount; ++producer) {
      if (concurrencyBoundViolated_[producer].load(
              std::memory_order_acquire))
        return true;
    }
    return false;
  }

 private:
  static constexpr uint32_t kProducerCount =
      static_cast<uint32_t>(AudioHostTerminalProducer::Count);

  static uint32_t index(AudioHostTerminalProducer producer) noexcept {
    const uint32_t value = static_cast<uint32_t>(producer);
    return value < kProducerCount
               ? value
               : static_cast<uint32_t>(AudioHostTerminalProducer::Provider);
  }

  AudioHostTerminalCause currentFor(uint32_t producer) const noexcept {
    return firstAudioHostTerminalCause(
        detail::unpackAudioHostTerminalCause(
            earliest_[producer].load(std::memory_order_acquire)),
        detail::unpackAudioHostTerminalCause(
            overflow_[producer].load(std::memory_order_acquire)));
  }

  std::array<std::atomic<uint64_t>, kProducerCount> earliest_{};
  std::array<std::atomic<uint64_t>, kProducerCount> overflow_{};
  std::array<std::atomic<uint32_t>, kProducerCount> activeRetainers_{};
  std::array<std::atomic<bool>, kProducerCount>
      concurrencyBoundViolated_{};
};

static_assert(std::atomic<uint64_t>::is_always_lock_free);
static_assert(std::atomic<uint32_t>::is_always_lock_free);

inline constexpr uint32_t kAudioHostMaxChannels = 64;
inline constexpr uint32_t kAudioHostMaxFrames = 8192;

enum class AudioHostAccessMode : uint32_t {
  Shared,
  Exclusive,
};

// Negotiated callback facts live with the callback contract rather than the
// control-only inventory API, so RT leaves never need owning/string headers.
struct AudioHostFormat {
  double sampleRate{0.0};
  uint32_t maximumFrames{0};
  uint32_t nominalBufferFrames{0};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  bool float32Planar{true};
  bool outputClockMaster{true};
  AudioHostAccessMode accessMode{AudioHostAccessMode::Shared};
};

constexpr uint64_t advanceAudioHostFrame(uint64_t value,
                                         uint32_t frames) noexcept {
  return value > UINT64_MAX - frames ? UINT64_MAX : value + frames;
}

constexpr bool validAudioHostSampleFrame(double value,
                                         uint32_t frames) noexcept {
  constexpr double kTwoTo64 = 18446744073709551616.0;
  return value >= 0.0 && value < kTwoTo64 &&
         static_cast<uint64_t>(value) <= UINT64_MAX - frames;
}

enum AudioHostDiscontinuity : uint32_t {
  AudioHostDiscontinuityNone = 0,
  AudioHostDiscontinuityStart = 1u << 0,
  AudioHostDiscontinuityRouteChanged = 1u << 1,
  AudioHostDiscontinuityXRun = 1u << 2,
  AudioHostDiscontinuityDeviceLost = 1u << 3,
  AudioHostDiscontinuityTimestampQualityChanged = 1u << 4,
  AudioHostDiscontinuityClockReanchored = 1u << 5,
  AudioHostDiscontinuitySequenceGap = 1u << 6,
};

struct AudioHostRenderBlock {
  const float* const* input{nullptr};
  float* const* output{nullptr};
  uint32_t inputChannels{0};
  uint32_t outputChannels{0};
  uint32_t frames{0};
  uint32_t maximumFrames{0};
  double sampleRate{0.0};
  uint64_t clockDomain{0};
  uint64_t routeGeneration{0};
  uint64_t streamGeneration{0};
  uint64_t callbackSequence{0};
  uint64_t inputSourceFrame{0};
  uint64_t inputSampleHostTimeNs{0};
  bool inputTimestampValid{false};
  bool inputTimestampHardware{false};
  uint64_t outputFrame{0};
  uint64_t outputHostTimeNs{0};
  bool outputTimestampValid{false};
  bool outputTimestampHardware{false};
  uint64_t callbackHostTimeNs{0};
  uint32_t discontinuity{AudioHostDiscontinuityNone};
  bool outputClockMaster{true};
};

using AudioHostRender = bool (*)(void*, const AudioHostRenderBlock&) noexcept;

}  // namespace singz
