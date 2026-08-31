#include <zcore/device/audio_input_callback_gate.h>

namespace singz {

void AudioInputCallbackGate::open() noexcept {
  // Reopening is legal only after the prior epoch is fully quiescent. Refuse
  // an accidental reopen while a closed epoch still owns callbacks.
  uint32_t expected = 0;
  state_.compare_exchange_strong(expected, kAccepting,
                                 std::memory_order_release,
                                 std::memory_order_relaxed);
}

void AudioInputCallbackGate::beginClose() noexcept {
  // This fetch-and and enter's CAS linearize admission and callback count in
  // one atomic state: either enter increments before this close (and teardown
  // observes its count), or it observes the cleared bit and rejects. There is
  // no separate-atomic window in which teardown can observe zero too early.
  state_.fetch_and(kCountMask, std::memory_order_acq_rel);
}

bool AudioInputCallbackGate::enter() noexcept {
  uint32_t observed = state_.load(std::memory_order_acquire);
  constexpr uint32_t kAttempts = 8;
  for (uint32_t attempt = 0; attempt < kAttempts; ++attempt) {
    if ((observed & kAccepting) == 0 ||
        (observed & kCountMask) == kCountMask) {
      return false;
    }
    if (state_.compare_exchange_weak(observed, observed + 1,
                                     std::memory_order_acq_rel,
                                     std::memory_order_acquire)) {
      return true;
    }
  }
  // Contention is fail-silent. The RT caller never spins without a bound.
  return false;
}

void AudioInputCallbackGate::leave() noexcept {
  state_.fetch_sub(1, std::memory_order_acq_rel);
}

uint32_t AudioInputCallbackGate::inFlight() const noexcept {
  return state_.load(std::memory_order_acquire) & kCountMask;
}

bool AudioInputCallbackGate::accepting() const noexcept {
  return (state_.load(std::memory_order_acquire) & kAccepting) != 0;
}

AudioInputCallbackScope::AudioInputCallbackScope(
    AudioInputCallbackGate& gate) noexcept
    : gate_(gate), entered_(gate_.enter()) {}

AudioInputCallbackScope::~AudioInputCallbackScope() noexcept {
  if (entered_) gate_.leave();
}

AudioInputCallbackScope::operator bool() const noexcept { return entered_; }

}  // namespace singz
