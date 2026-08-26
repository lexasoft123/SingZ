#include <zcore/audio/audio_input_producer.h>

#include <cstring>

#include "audio_input_transport_internal.h"

namespace singz {

bool AudioInputRingProducer::push(
    const float* mono, uint32_t frames, uint64_t sampleHostTimeNs,
    uint64_t callbackHostTimeNs,
    AudioInputTimestampQuality timestampQuality) const noexcept {
  AudioInputRingCallbackState* state = state_;
  if (!state) return false;
  const uint64_t attemptSequence = state->nextSequence++;
  if (!mono || frames == 0 || frames > state->maxFrames) {
    state->dropped.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  const uint32_t producer =
      state->producerCursor.load(std::memory_order_relaxed);
  const uint32_t consumer =
      state->consumerCursor.load(std::memory_order_acquire);
  if (static_cast<uint32_t>(producer - consumer) >= state->slotCount) {
    state->dropped.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  AudioInputRingSlot& slot = state->slots[producer % state->slotCount];
  std::memcpy(slot.samples, mono, static_cast<size_t>(frames) * sizeof(float));
  slot.frames = frames;
  slot.sequence = attemptSequence;
  slot.sampleHostTimeNs = sampleHostTimeNs;
  slot.callbackHostTimeNs = callbackHostTimeNs;
  slot.timestampQuality = timestampQuality;
  state->producerCursor.store(producer + 1, std::memory_order_release);
  return true;
}

}  // namespace singz
