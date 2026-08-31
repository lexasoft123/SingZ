#pragma once

#include <atomic>
#include <cstdint>

#include <zcore/audio/audio_input_producer.h>

#if defined(__GNUC__) || defined(__clang__)
#define SINGZ_ZCORE_CALLBACK_LOCAL __attribute__((visibility("hidden")))
#else
#define SINGZ_ZCORE_CALLBACK_LOCAL
#endif

namespace singz {

using AudioInputCallbackNotify = void (*)(void*) noexcept;

// Prepared off the real-time thread. The provider passes push() and this
// object to the system driver; push() performs one bounded ring copy and
// coalesces delivery notification without reaching lifecycle state. notify
// must name the prepared fixed-size platform wake operation.
class SINGZ_ZCORE_CALLBACK_LOCAL AudioInputCallbackEndpoint {
 public:
  void prepare(AudioInputRingProducer producer, AudioInputCallbackNotify notify,
               void* notifyContext) noexcept;
  void clear() noexcept;
  void resetNotification() noexcept;
  bool rearmNotification() noexcept;

  static bool push(void* context, const float* mono, uint32_t frames,
                   uint64_t sampleHostTimeNs, uint64_t callbackHostTimeNs,
                   AudioInputTimestampQuality timestampQuality) noexcept;

 private:
  static_assert(std::atomic<bool>::is_always_lock_free,
                "audio callback notification requires lock-free bool atomics");
  AudioInputRingProducer producer_;
  AudioInputCallbackNotify notify_ = nullptr;
  void* notifyContext_ = nullptr;
  std::atomic<bool> notificationPending_{false};
};

}  // namespace singz

#undef SINGZ_ZCORE_CALLBACK_LOCAL
