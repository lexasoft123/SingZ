#pragma once
#include <atomic>

// Shared progress/cancel contract for every long job in the core (split,
// beat inference, FLAC encode). The host owns the callback thread: Android
// calls from the :split service, iOS from the BGContinuedProcessingTask
// worker. `cancel` is flipped by the host; stages poll it between segments —
// a segment in flight finishes, which keeps the resume checkpoint coherent.
namespace singz {

struct Progress {
  using Callback = void (*)(void* user, const char* stage, float frac);

  Callback cb = nullptr;
  void* user = nullptr;
  std::atomic<bool> cancel{false};

  void report(const char* stage, float frac) const {
    if (cb != nullptr) cb(user, stage, frac);
  }
  bool cancelled() const { return cancel.load(std::memory_order_relaxed); }
};

}  // namespace singz
