#pragma once

#include <cstdint>
#include <memory>

#include <zcore/audio/audio_input_producer.h>

#if defined(__GNUC__) || defined(__clang__)
#define SINGZ_ZCORE_CALLBACK_LOCAL __attribute__((visibility("hidden")))
#else
#define SINGZ_ZCORE_CALLBACK_LOCAL
#endif

namespace singz {

struct AudioInputBlockView {
  AudioInputCaptureMetadata capture;
  // Compatibility aliases retained while existing delivery consumers move to
  // capture.*. New code must use the typed metadata object above.
  uint64_t sequence = 0;
  uint64_t sampleHostTimeNs = 0;
  uint64_t callbackHostTimeNs = 0;
  AudioInputTimestampQuality timestampQuality =
      AudioInputTimestampQuality::Unknown;
  double sampleRate = 0;
  const float* mono = nullptr;
  uint32_t frames = 0;
};

// Preallocated SPSC transport. Platform callbacks receive producer(); the
// legacy push() entry point remains source-compatible and delegates to that
// same lock-free producer view. The remaining methods belong to the ordinary
// delivery thread. Construction is the stream-generation boundary that
// initializes source-frame validity; after uint64 saturation this ring keeps
// the source frame invalid until its owner constructs the next generation.
class AudioInputRing {
 public:
  AudioInputRing(uint32_t blocks, uint32_t maxFrames,
                 uint64_t clockDomainId = 1,
                 uint64_t streamGeneration = 1,
                 uint64_t initialSourceFrame = 0);
  ~AudioInputRing();
  AudioInputRing(const AudioInputRing&) = delete;
  AudioInputRing& operator=(const AudioInputRing&) = delete;

  bool valid() const;
  SINGZ_ZCORE_CALLBACK_LOCAL bool push(
      const float* mono, uint32_t frames, uint64_t sampleHostTimeNs,
      uint64_t callbackHostTimeNs = 0,
      AudioInputTimestampQuality timestampQuality =
          AudioInputTimestampQuality::Unknown) noexcept;
  AudioInputRingProducer producer() noexcept {
    return AudioInputRingProducer(callback_);
  }
  bool peek(AudioInputBlockView& out, double sampleRate);
  void consume();
  uint64_t overruns() const;
  uint32_t capacity() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  // Prepared by the owning/control half and borrowed only by producer views.
  // Keeping the callback state separate lets the strict implementation compile
  // without exposing owning containers or consumer operations.
  AudioInputRingCallbackState* callback_ = nullptr;
};

}  // namespace singz

#undef SINGZ_ZCORE_CALLBACK_LOCAL
