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

// Lifetime seam for a platform callback object that outlives the backend it
// calls. Unlike a bare atomic owner pointer, entry is counted before the owner
// is loaded. Teardown closes admission, waits for inFlight()==0, and only then
// clears the owner. A callback racing after the zero observation can increment
// the counter, but it observes closed admission and never loads the pointer.
template <typename Owner>
class AudioInputCallbackOwnerGate {
 public:
  static_assert(std::atomic<Owner*>::is_always_lock_free,
                "audio callback owner gate requires lock-free pointer atomics");

  void open(Owner* owner) noexcept {
    owner_.store(owner, std::memory_order_release);
    admission_.open();
  }

  void beginClose() noexcept { admission_.beginClose(); }

  Owner* enter() noexcept {
    if (!admission_.enter()) return nullptr;
    Owner* owner = owner_.load(std::memory_order_acquire);
    if (owner) return owner;
    admission_.leave();
    return nullptr;
  }

  void leave() noexcept { admission_.leave(); }
  uint32_t inFlight() const noexcept { return admission_.inFlight(); }
  bool accepting() const noexcept { return admission_.accepting(); }

  // Refuse an unsafe clear rather than turning a control-thread ordering bug
  // into a callback use-after-free.
  bool clearOwnerIfQuiescent() noexcept {
    if (admission_.accepting() || admission_.inFlight() != 0) return false;
    owner_.store(nullptr, std::memory_order_release);
    return true;
  }

 private:
  AudioInputCallbackGate admission_;
  std::atomic<Owner*> owner_{nullptr};
};

template <typename Owner>
class AudioInputCallbackOwnerScope {
 public:
  explicit AudioInputCallbackOwnerScope(
      AudioInputCallbackOwnerGate<Owner>& gate) noexcept
      : gate_(gate), owner_(gate_.enter()) {}

  AudioInputCallbackOwnerScope(const AudioInputCallbackOwnerScope&) = delete;
  AudioInputCallbackOwnerScope& operator=(const AudioInputCallbackOwnerScope&) = delete;

  ~AudioInputCallbackOwnerScope() noexcept {
    if (owner_) gate_.leave();
  }

  Owner* get() const noexcept { return owner_; }
  Owner* operator->() const noexcept { return owner_; }
  explicit operator bool() const noexcept { return owner_ != nullptr; }

 private:
  AudioInputCallbackOwnerGate<Owner>& gate_;
  Owner* owner_ = nullptr;
};

}  // namespace singz

#undef SINGZ_ZCORE_CALLBACK_LOCAL
