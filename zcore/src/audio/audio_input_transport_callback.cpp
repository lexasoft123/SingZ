#include <zcore/audio/audio_input_producer.h>

#include <cstring>
#include <limits>

#include "audio_input_transport_internal.h"

namespace singz {

bool AudioInputRingProducer::push(
    const float* mono, uint32_t frames, uint64_t sampleHostTimeNs,
    uint64_t callbackHostTimeNs,
    AudioInputTimestampQuality timestampQuality) const noexcept {
  AudioInputRingCallbackState* state = state_;
  if (!state) return false;
  const uint64_t attemptSequence = state->nextSequence++;
  const uint64_t attemptSourceFrame = state->nextSourceFrame;
  if (frames != 0) {
    if (state->sourceFrameValid &&
        frames > std::numeric_limits<uint64_t>::max() - state->nextSourceFrame) {
      state->nextSourceFrame = std::numeric_limits<uint64_t>::max();
      state->sourceFrameValid = false;
      state->sourceFrameOverflowPending = true;
    } else if (state->sourceFrameValid) {
      state->nextSourceFrame += frames;
    }
  }
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
  slot.capture.clockDomainId = state->clockDomainId;
  slot.capture.streamGeneration = state->streamGeneration;
  slot.capture.sequence = attemptSequence;
  slot.capture.sourceFrame = attemptSourceFrame;
  slot.capture.sampleHostTimeNs = sampleHostTimeNs;
  slot.capture.callbackHostTimeNs = callbackHostTimeNs;
  slot.capture.timestampQuality = timestampQuality;
  const bool sequenceGap = state->havePublished
      ? attemptSequence != state->lastPublishedSequence + 1
      : attemptSequence != 0;
  const bool qualityChanged = state->haveTimestampQuality &&
      timestampQuality != state->lastTimestampQuality;
  slot.capture.discontinuity = state->sourceFrameOverflowPending
      ? AudioInputDiscontinuityReason::SourceFrameOverflow
      : sequenceGap
      ? AudioInputDiscontinuityReason::SequenceGap
      : qualityChanged
          ? AudioInputDiscontinuityReason::TimestampQualityChanged
          : AudioInputDiscontinuityReason::None;
  slot.capture.flags =
      (state->sourceFrameValid ? AudioInputSourceFrameValid : 0u) |
      (sampleHostTimeNs ? AudioInputSampleHostTimeValid : 0u) |
      (callbackHostTimeNs ? AudioInputCallbackHostTimeValid : 0u) |
      (timestampQuality != AudioInputTimestampQuality::Unknown
           ? AudioInputTimestampQualityValid
           : 0u) |
      (timestampQuality == AudioInputTimestampQuality::CallbackEstimate
           ? AudioInputStaleAnchor
           : 0u) |
      (slot.capture.discontinuity != AudioInputDiscontinuityReason::None
           ? AudioInputDiscontinuous
           : 0u);
  state->lastPublishedSequence = attemptSequence;
  state->havePublished = true;
  state->lastTimestampQuality = timestampQuality;
  state->haveTimestampQuality = true;
  state->sourceFrameOverflowPending = false;
  state->producerCursor.store(producer + 1, std::memory_order_release);
  return true;
}

}  // namespace singz
