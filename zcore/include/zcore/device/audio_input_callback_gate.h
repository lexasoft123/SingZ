#pragma once

#include <atomic>
#include <cstdint>

#if defined(__GNUC__) || defined(__clang__)
#define SINGZ_ZCORE_CALLBACK_LOCAL __attribute__((visibility("hidden")))
#else
#define SINGZ_ZCORE_CALLBACK_LOCAL
#endif

namespace singz {

// Lock-free callback lifetime seam. Control code closes the gate before
// stopping a platform stream, then waits off RT for inFlight()==0 before
// destroying callback-owned buffers/state.
class SINGZ_ZCORE_CALLBACK_LOCAL AudioInputCallbackGate {
 public:
  void open() noexcept;
  void beginClose() noexcept;
  bool enter() noexcept;
  void leave() noexcept;
  uint32_t inFlight() const noexcept;
  bool accepting() const noexcept;

 private:
  static_assert(std::atomic<uint32_t>::is_always_lock_free,
                "audio callback gate requires lock-free 32-bit atomics");
  std::atomic<bool> accepting_{false};
  std::atomic<uint32_t> inFlight_{0};
};

class SINGZ_ZCORE_CALLBACK_LOCAL AudioInputCallbackScope {
 public:
  explicit AudioInputCallbackScope(AudioInputCallbackGate& gate) noexcept;
  ~AudioInputCallbackScope() noexcept;
  explicit operator bool() const noexcept;

 private:
  AudioInputCallbackGate& gate_;
  bool entered_ = false;
};

}  // namespace singz

#undef SINGZ_ZCORE_CALLBACK_LOCAL
