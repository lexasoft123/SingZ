#pragma once

#include <atomic>
#include <cstdint>

#include <zcore/audio/audio_input_producer.h>

namespace singz {

struct AudioInputRingSlot {
  float* samples = nullptr;
  uint32_t frames = 0;
  uint64_t sequence = 0;
  uint64_t sampleHostTimeNs = 0;
  uint64_t callbackHostTimeNs = 0;
  AudioInputTimestampQuality timestampQuality =
      AudioInputTimestampQuality::Unknown;
};

// Raw, prebound view used by the producer. Ownership and counter widening stay
// in the ordinary-thread half of AudioInputRing.
struct AudioInputRingCallbackState {
  AudioInputRingSlot* slots = nullptr;
  uint32_t slotCount = 0;
  uint32_t maxFrames = 0;
  static_assert(std::atomic<uint32_t>::is_always_lock_free,
                "audio callback requires lock-free 32-bit atomics");
  alignas(64) std::atomic<uint32_t> producerCursor{0};
  alignas(64) std::atomic<uint32_t> consumerCursor{0};
  std::atomic<uint32_t> dropped{0};
  uint64_t nextSequence = 0;
};

}  // namespace singz
