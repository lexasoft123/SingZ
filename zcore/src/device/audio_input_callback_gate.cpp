#include <zcore/device/audio_input_callback_gate.h>

namespace singz {

void AudioInputCallbackGate::open() noexcept {
  accepting_.store(true, std::memory_order_release);
}

void AudioInputCallbackGate::beginClose() noexcept {
  accepting_.store(false, std::memory_order_release);
}

bool AudioInputCallbackGate::enter() noexcept {
  inFlight_.fetch_add(1, std::memory_order_acq_rel);
  if (accepting_.load(std::memory_order_acquire)) return true;
  leave();
  return false;
}

void AudioInputCallbackGate::leave() noexcept {
  inFlight_.fetch_sub(1, std::memory_order_acq_rel);
}

uint32_t AudioInputCallbackGate::inFlight() const noexcept {
  return inFlight_.load(std::memory_order_acquire);
}

bool AudioInputCallbackGate::accepting() const noexcept {
  return accepting_.load(std::memory_order_acquire);
}

AudioInputCallbackScope::AudioInputCallbackScope(
    AudioInputCallbackGate& gate) noexcept
    : gate_(gate), entered_(gate_.enter()) {}

AudioInputCallbackScope::~AudioInputCallbackScope() noexcept {
  if (entered_) gate_.leave();
}

AudioInputCallbackScope::operator bool() const noexcept { return entered_; }

}  // namespace singz
