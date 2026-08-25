#pragma once

#include <atomic>
#include <cstdint>

namespace singz {

// Lock-free callback lifetime seam. Control code closes the gate before
// stopping a platform stream, then waits off RT for inFlight()==0 before
// destroying callback-owned buffers/state.
class AudioInputCallbackGate {
 public:
  void open() { accepting_.store(true, std::memory_order_release); }
  void beginClose() { accepting_.store(false, std::memory_order_release); }

  bool enter() {
    inFlight_.fetch_add(1, std::memory_order_acq_rel);
    if (accepting_.load(std::memory_order_acquire)) return true;
    leave();
    return false;
  }

  void leave() { inFlight_.fetch_sub(1, std::memory_order_acq_rel); }
  uint32_t inFlight() const { return inFlight_.load(std::memory_order_acquire); }
  bool accepting() const { return accepting_.load(std::memory_order_acquire); }

 private:
  static_assert(std::atomic<uint32_t>::is_always_lock_free,
                "audio callback gate requires lock-free 32-bit atomics");
  std::atomic<bool> accepting_{false};
  std::atomic<uint32_t> inFlight_{0};
};

class AudioInputCallbackScope {
 public:
  explicit AudioInputCallbackScope(AudioInputCallbackGate& gate)
      : gate_(gate), entered_(gate_.enter()) {}
  ~AudioInputCallbackScope() {
    if (entered_) gate_.leave();
  }
  explicit operator bool() const { return entered_; }

 private:
  AudioInputCallbackGate& gate_;
  bool entered_ = false;
};

}  // namespace singz
