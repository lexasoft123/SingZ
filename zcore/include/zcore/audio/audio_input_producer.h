#pragma once

#include <cstdint>

#include <zcore/audio/capture_block.h>

#if defined(__GNUC__) || defined(__clang__)
#define SINGZ_ZCORE_CALLBACK_LOCAL __attribute__((visibility("hidden")))
#else
#define SINGZ_ZCORE_CALLBACK_LOCAL
#endif

namespace singz {

struct AudioInputRingCallbackState;

// Narrow, non-owning producer view prepared by AudioInputRing off RT. This is
// the only ring type visible to the strict callback target: storage ownership,
// consumer operations and diagnostics remain in audio_input_transport.h.
class SINGZ_ZCORE_CALLBACK_LOCAL AudioInputRingProducer {
 public:
  AudioInputRingProducer() noexcept = default;

  bool push(const float* mono, uint32_t frames, uint64_t sampleHostTimeNs,
            uint64_t callbackHostTimeNs = 0,
            AudioInputTimestampQuality timestampQuality =
                AudioInputTimestampQuality::Unknown) const noexcept;

 private:
  friend class AudioInputRing;
  explicit AudioInputRingProducer(AudioInputRingCallbackState* state) noexcept
      : state_(state) {}

  AudioInputRingCallbackState* state_ = nullptr;
};

}  // namespace singz

#undef SINGZ_ZCORE_CALLBACK_LOCAL
