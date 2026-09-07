#include <zcore/audio/audio_input_transport.h>

#include <cmath>
#include <mutex>
#include <vector>

#include "audio_input_transport_internal.h"

namespace singz {
namespace {

constexpr uint32_t kMinRingBlocks = 2;
constexpr uint32_t kMaxRingBlocks = 256;
constexpr uint32_t kMaxCallbackFrames = 16384;

}  // namespace

struct AudioInputRing::Impl {
  Impl(uint32_t count, uint32_t frames, uint64_t clockDomain,
       uint64_t generation, uint64_t initialSourceFrame)
      : slots(count), samples(static_cast<size_t>(count) * frames) {
    for (uint32_t slot = 0; slot < count; ++slot)
      slots[slot].samples = samples.data() + static_cast<size_t>(slot) * frames;
    callback.slots = slots.data();
    callback.slotCount = count;
    callback.maxFrames = frames;
    callback.clockDomainId = clockDomain;
    callback.streamGeneration = generation;
    callback.nextSourceFrame = initialSourceFrame;
  }

  std::vector<AudioInputRingSlot> slots;
  std::vector<float> samples;
  AudioInputRingCallbackState callback;
  mutable std::mutex droppedReadMutex;
  mutable uint32_t lastDroppedRaw = 0;
  mutable uint64_t widenedDropped = 0;
};

AudioInputRing::AudioInputRing(uint32_t blocks, uint32_t maxFrames,
                               uint64_t clockDomainId,
                               uint64_t streamGeneration,
                               uint64_t initialSourceFrame) {
  if (blocks >= kMinRingBlocks && blocks <= kMaxRingBlocks && maxFrames > 0 &&
      maxFrames <= kMaxCallbackFrames && clockDomainId != 0 &&
      streamGeneration != 0) {
    impl_ = std::make_unique<Impl>(blocks, maxFrames, clockDomainId,
                                  streamGeneration, initialSourceFrame);
    callback_ = &impl_->callback;
  }
}

AudioInputRing::~AudioInputRing() { callback_ = nullptr; }

bool AudioInputRing::valid() const { return impl_ != nullptr; }

bool AudioInputRing::push(
    const float* mono, uint32_t frames, uint64_t sampleHostTimeNs,
    uint64_t callbackHostTimeNs,
    AudioInputTimestampQuality timestampQuality) noexcept {
  return producer().push(mono, frames, sampleHostTimeNs, callbackHostTimeNs,
                         timestampQuality);
}

bool AudioInputRing::peek(AudioInputBlockView& out, double sampleRate) {
  if (!impl_) return false;
  AudioInputRingCallbackState& state = impl_->callback;
  const uint32_t consumer =
      state.consumerCursor.load(std::memory_order_relaxed);
  if (consumer == state.producerCursor.load(std::memory_order_acquire))
    return false;
  AudioInputRingSlot& slot = impl_->slots[consumer % state.slotCount];
  out.capture = slot.capture;
  out.sequence = slot.sequence;
  out.sampleHostTimeNs = slot.sampleHostTimeNs;
  out.callbackHostTimeNs = slot.callbackHostTimeNs;
  out.timestampQuality = slot.timestampQuality;
  out.sampleRate = sampleRate;
  // Hardware/driver faults must not inject NaN or infinity into downstream
  // vocal processors. This scan is on the ordinary consumer thread, never
  // the real-time callback.
  for (uint32_t i = 0; i < slot.frames; ++i)
    if (!std::isfinite(slot.samples[i])) slot.samples[i] = 0;
  out.mono = slot.samples;
  out.frames = slot.frames;
  return true;
}

void AudioInputRing::consume() {
  if (!impl_) return;
  AudioInputRingCallbackState& state = impl_->callback;
  const uint32_t consumer =
      state.consumerCursor.load(std::memory_order_relaxed);
  if (consumer != state.producerCursor.load(std::memory_order_acquire))
    state.consumerCursor.store(consumer + 1, std::memory_order_release);
}

uint64_t AudioInputRing::overruns() const {
  if (!impl_) return 0;
  // Widen the lock-free producer counter off RT. Unsigned subtraction handles
  // wrap; polling more often than 2^32 dropped callbacks is an easy invariant
  // (over a year even at 100 callbacks/s). Multiple readers serialize here.
  std::lock_guard<std::mutex> lock(impl_->droppedReadMutex);
  const uint32_t raw = impl_->callback.dropped.load(std::memory_order_relaxed);
  impl_->widenedDropped += static_cast<uint32_t>(raw - impl_->lastDroppedRaw);
  impl_->lastDroppedRaw = raw;
  return impl_->widenedDropped;
}

uint32_t AudioInputRing::capacity() const {
  return impl_ ? static_cast<uint32_t>(impl_->slots.size()) : 0;
}

}  // namespace singz
