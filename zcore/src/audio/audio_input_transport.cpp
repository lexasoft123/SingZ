#include <zcore/audio/audio_input_transport.h>

#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <vector>

namespace singz {
namespace {

constexpr uint32_t kMinRingBlocks = 2;
constexpr uint32_t kMaxRingBlocks = 256;
constexpr uint32_t kMaxCallbackFrames = 16384;

struct RingSlot {
  std::vector<float> samples;
  uint32_t frames = 0;
  uint64_t sequence = 0;
  uint64_t sampleHostTimeNs = 0;
  uint64_t callbackHostTimeNs = 0;
  AudioInputTimestampQuality timestampQuality =
      AudioInputTimestampQuality::Unknown;
};

}  // namespace

struct AudioInputRing::Impl {
  Impl(uint32_t count, uint32_t frames) : slots(count), maxFrames(frames) {
    for (RingSlot& slot : slots) slot.samples.resize(frames);
  }

  std::vector<RingSlot> slots;
  uint32_t maxFrames = 0;
  // The app still ships armeabi-v7a. uint64 atomics may call a locked runtime
  // helper there, so every counter touched by the real-time producer is
  // deliberately 32-bit and compile-time required to be lock-free. Unsigned
  // distance remains correct across wrap because the ring is at most 256.
  static_assert(std::atomic<uint32_t>::is_always_lock_free,
                "audio callback requires lock-free 32-bit atomics");
  alignas(64) std::atomic<uint32_t> write{0};
  alignas(64) std::atomic<uint32_t> read{0};
  std::atomic<uint32_t> dropped{0};
  uint64_t nextSequence = 0;  // producer-owned, never read on another thread
  mutable std::mutex droppedReadMutex;
  mutable uint32_t lastDroppedRaw = 0;
  mutable uint64_t widenedDropped = 0;
};

AudioInputRing::AudioInputRing(uint32_t blocks, uint32_t maxFrames) {
  if (blocks >= kMinRingBlocks && blocks <= kMaxRingBlocks && maxFrames > 0 &&
      maxFrames <= kMaxCallbackFrames) {
    impl_ = std::make_unique<Impl>(blocks, maxFrames);
  }
}

AudioInputRing::~AudioInputRing() = default;

bool AudioInputRing::valid() const { return impl_ != nullptr; }

bool AudioInputRing::push(const float* mono, uint32_t frames,
                          uint64_t sampleHostTimeNs,
                          uint64_t callbackHostTimeNs,
                          AudioInputTimestampQuality timestampQuality) {
  if (!impl_) return false;
  // A sequence describes a hardware callback ATTEMPT, not a ring insertion.
  // The next accepted block therefore exposes any dropped callback as a gap.
  const uint64_t attemptSequence = impl_->nextSequence++;
  if (!mono || frames == 0 || frames > impl_->maxFrames) {
    impl_->dropped.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  const uint32_t write = impl_->write.load(std::memory_order_relaxed);
  const uint32_t read = impl_->read.load(std::memory_order_acquire);
  if (static_cast<uint32_t>(write - read) >= impl_->slots.size()) {
    impl_->dropped.fetch_add(1, std::memory_order_relaxed);
    return false;
  }
  RingSlot& slot = impl_->slots[static_cast<size_t>(write % impl_->slots.size())];
  std::memcpy(slot.samples.data(), mono, static_cast<size_t>(frames) * sizeof(float));
  slot.frames = frames;
  slot.sequence = attemptSequence;
  slot.sampleHostTimeNs = sampleHostTimeNs;
  slot.callbackHostTimeNs = callbackHostTimeNs;
  slot.timestampQuality = timestampQuality;
  impl_->write.store(write + 1, std::memory_order_release);
  return true;
}

bool AudioInputRing::peek(AudioInputBlockView& out, double sampleRate) {
  if (!impl_) return false;
  const uint32_t read = impl_->read.load(std::memory_order_relaxed);
  if (read == impl_->write.load(std::memory_order_acquire)) return false;
  RingSlot& slot = impl_->slots[static_cast<size_t>(read % impl_->slots.size())];
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
  out.mono = slot.samples.data();
  out.frames = slot.frames;
  return true;
}

void AudioInputRing::consume() {
  if (!impl_) return;
  const uint32_t read = impl_->read.load(std::memory_order_relaxed);
  if (read != impl_->write.load(std::memory_order_acquire))
    impl_->read.store(read + 1, std::memory_order_release);
}

uint64_t AudioInputRing::overruns() const {
  if (!impl_) return 0;
  // Widen the lock-free producer counter off RT. Unsigned subtraction handles
  // wrap; polling more often than 2^32 dropped callbacks is an easy invariant
  // (over a year even at 100 callbacks/s). Multiple readers serialize here.
  std::lock_guard<std::mutex> lock(impl_->droppedReadMutex);
  const uint32_t raw = impl_->dropped.load(std::memory_order_relaxed);
  impl_->widenedDropped += static_cast<uint32_t>(raw - impl_->lastDroppedRaw);
  impl_->lastDroppedRaw = raw;
  return impl_->widenedDropped;
}

uint32_t AudioInputRing::capacity() const {
  return impl_ ? static_cast<uint32_t>(impl_->slots.size()) : 0;
}

}  // namespace singz
