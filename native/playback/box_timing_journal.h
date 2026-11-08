#pragma once
#include <atomic>
#include <cstdint>
#include <limits>

namespace singz::box_timing {
static_assert(std::atomic<uint64_t>::is_always_lock_free &&
              std::atomic<bool>::is_always_lock_free,
              "Box realtime timing journals require lock-free atomics");
// A reservation counter gives each publisher a unique index, but does not
// serialize publishers that wrap to the same slot. Claim once: never replace
// another publisher's odd token or let a delayed old reservation replace newer
// data. Losing telemetry disables projection until the owner drains all workers.
inline bool tryClaim(std::atomic<uint64_t>& sequence, uint64_t index,
                     std::atomic<bool>& coverageLost) noexcept {
  constexpr uint64_t maximumIndex = (std::numeric_limits<uint64_t>::max() - 2) / 2;
  if (index > maximumIndex) {
    coverageLost.store(true, std::memory_order_release);
    return false;
  }
  const uint64_t claim = index * 2 + 1;
  uint64_t observed = sequence.load(std::memory_order_acquire);
  if ((observed & 1) || observed >= claim ||
      !sequence.compare_exchange_strong(observed, claim,
          std::memory_order_acq_rel, std::memory_order_acquire)) {
    coverageLost.store(true, std::memory_order_release);
    return false;
  }
  // This release fence pairs with the reader's closing acquire fence when a
  // relaxed payload load observes this writer. That synchronizes the preceding
  // odd claim with the closing sequence read, which must then reject old even
  // sequence values. The release CAS alone is on a different atomic and is not
  // the required fence-to-fence synchronization through a payload field.
  std::atomic_thread_fence(std::memory_order_release);
  return true;
}
inline void publish(std::atomic<uint64_t>& sequence, uint64_t index) noexcept {
  sequence.store(index * 2 + 2, std::memory_order_release);
}
inline bool published(const std::atomic<uint64_t>& sequence, uint64_t index) noexcept {
  return index <= (std::numeric_limits<uint64_t>::max() - 2) / 2 &&
         sequence.load(std::memory_order_acquire) == index * 2 + 2;
}
inline bool stillPublished(const std::atomic<uint64_t>& sequence, uint64_t expected) noexcept {
  // Keep payload loads before the closing sequence observation on weak memory
  // machines as well as in the compiler. Payload fields themselves are atomic.
  std::atomic_thread_fence(std::memory_order_acquire);
  return sequence.load(std::memory_order_relaxed) == expected;
}
// A new reservation outside a reader's scanned window may contain a relevant
// failure or clock boundary. A projection cannot certify an unchanged snapshot
// unless both reservation counters and the sticky coverage fence still agree.
inline bool unchanged(const std::atomic<uint64_t>& physicalWritten, uint64_t physicalEnd,
                      const std::atomic<uint64_t>& missingWritten, uint64_t missingEnd,
                      const std::atomic<bool>& coverageLost) noexcept {
  std::atomic_thread_fence(std::memory_order_acquire);
  return physicalWritten.load(std::memory_order_acquire) == physicalEnd &&
         missingWritten.load(std::memory_order_acquire) == missingEnd &&
         !coverageLost.load(std::memory_order_acquire);
}
} // namespace singz::box_timing
