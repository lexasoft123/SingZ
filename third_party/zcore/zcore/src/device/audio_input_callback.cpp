#include "audio_input_callback.h"

namespace singz {

void AudioInputCallbackEndpoint::prepare(
    AudioInputRingProducer producer, AudioInputCallbackNotify notify,
    void* notifyContext) noexcept {
  producer_ = producer;
  notify_ = notify;
  notifyContext_ = notifyContext;
  notificationPending_.store(false, std::memory_order_relaxed);
}

void AudioInputCallbackEndpoint::clear() noexcept {
  producer_ = AudioInputRingProducer{};
  notify_ = nullptr;
  notifyContext_ = nullptr;
  notificationPending_.store(false, std::memory_order_relaxed);
}

void AudioInputCallbackEndpoint::resetNotification() noexcept {
  notificationPending_.store(false, std::memory_order_release);
}

bool AudioInputCallbackEndpoint::rearmNotification() noexcept {
  return notificationPending_.exchange(false, std::memory_order_acq_rel);
}

bool AudioInputCallbackEndpoint::push(
    void* context, const float* mono, uint32_t frames,
    uint64_t sampleHostTimeNs, uint64_t callbackHostTimeNs,
    AudioInputTimestampQuality timestampQuality) noexcept {
  auto* endpoint = static_cast<AudioInputCallbackEndpoint*>(context);
  if (!endpoint) return false;
  const bool pushed = endpoint->producer_.push(
      mono, frames, sampleHostTimeNs, callbackHostTimeNs, timestampQuality);
  if (pushed &&
      !endpoint->notificationPending_.exchange(true, std::memory_order_acq_rel) &&
      endpoint->notify_) {
    endpoint->notify_(endpoint->notifyContext_);
  }
  return pushed;
}

}  // namespace singz
