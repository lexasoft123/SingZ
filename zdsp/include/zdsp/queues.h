#pragma once

#include "zdsp/events.h"

#include <atomic>
#include <cmath>

namespace zdsp {

struct RuntimeDiagnostics {
  // Callback-side counters deliberately use the native nonblocking width on
  // every supported ABI (including armv7). Control code widens sampled deltas
  // and therefore tolerates modulo wrap without putting 64-bit atomics on RT.
  std::atomic<uint32_t> parameterOverflows{0};
  std::atomic<uint32_t> musicalEventOverflows{0};
  std::atomic<uint32_t> nonFiniteSamples{0};
  std::atomic<uint32_t> rejectedBlocks{0};
  std::atomic<uint32_t> publicationDeferrals{0};
  std::atomic<uint32_t> retirementSaturations{0};
  std::atomic<uint32_t> transitionRejections{0};
};

static_assert(std::atomic<uint32_t>::is_always_lock_free);

template <typename T, uint32_t Capacity>
class SpscQueue {
 public:
  static_assert(Capacity >= 2);

  bool push(const T& value) noexcept {
    const uint32_t producer = producer_.load(std::memory_order_relaxed);
    const uint32_t next = increment(producer);
    if (next == consumer_.load(std::memory_order_acquire)) return false;
    entries_[producer] = value;
    producer_.store(next, std::memory_order_release);
    return true;
  }

  bool pop(T* value) noexcept {
    if (value == nullptr) return false;
    const uint32_t consumer = consumer_.load(std::memory_order_relaxed);
    if (consumer == producer_.load(std::memory_order_acquire)) return false;
    *value = entries_[consumer];
    consumer_.store(increment(consumer), std::memory_order_release);
    return true;
  }

  // Capture the consumer-visible queue boundary once. A callback must never
  // keep following a concurrently advancing producer index: entries published
  // after this snapshot belong to the next block.
  [[nodiscard]] uint32_t snapshotAvailable() const noexcept {
    const uint32_t consumer = consumer_.load(std::memory_order_relaxed);
    const uint32_t producer = producer_.load(std::memory_order_acquire);
    return producer >= consumer ? producer - consumer
                                : Capacity - consumer + producer;
  }

  uint32_t drain(T* destination, uint32_t capacity) noexcept {
    uint32_t count = 0;
    uint32_t available = snapshotAvailable();
    if (available > capacity) available = capacity;
    while (count < available && pop(destination + count)) ++count;
    return count;
  }

 private:
  static constexpr uint32_t increment(uint32_t value) noexcept {
    return value + 1 == Capacity ? 0 : value + 1;
  }
  T entries_[Capacity]{};
  std::atomic<uint32_t> producer_{0};
  std::atomic<uint32_t> consumer_{0};
};

inline constexpr uint32_t kRuntimeEventQueueCapacity = 1024;
using ParameterQueue = SpscQueue<ParameterEvent, kRuntimeEventQueueCapacity>;
using MusicalEventQueue = SpscQueue<MusicalEvent, kRuntimeEventQueueCapacity>;

inline bool enqueueParameter(ParameterQueue* queue, const ParameterEvent& event,
                             RuntimeDiagnostics* diagnostics) noexcept {
  const bool valid = std::isfinite(event.value) &&
      (event.curve == ParameterCurve::Step ||
       event.curve == ParameterCurve::Linear);
  if (valid && queue != nullptr && queue->push(event)) return true;
  if (diagnostics != nullptr)
    diagnostics->parameterOverflows.fetch_add(1, std::memory_order_relaxed);
  return false;
}

inline bool enqueueMusicalEvent(MusicalEventQueue* queue,
                                const MusicalEvent& event,
                                RuntimeDiagnostics* diagnostics) noexcept {
  const bool valid = std::isfinite(event.value) && event.channel <= 15 &&
      event.key <= 127 && event.kind <= MusicalEventKind::AllNotesOff;
  if (valid && queue != nullptr && queue->push(event)) return true;
  if (diagnostics != nullptr)
    diagnostics->musicalEventOverflows.fetch_add(1, std::memory_order_relaxed);
  return false;
}

}  // namespace zdsp
