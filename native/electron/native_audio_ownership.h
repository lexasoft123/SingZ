#pragma once

#include <cstdint>
#include <mutex>

namespace singz {

enum class NativeAudioOwnerKind : uint32_t {
  None,
  Capture,
  Playback,
};

enum class NativeAudioAcquireResult : uint32_t {
  Acquired,
  Busy,
  InvalidGeneration,
};

struct NativeAudioOwnershipSnapshot {
  NativeAudioOwnerKind kind{NativeAudioOwnerKind::None};
  uint64_t generation{0};
};

// Addon-wide control-domain arbitration. The shared-service bridge can opt
// into independent capture and playback leases.
class NativeAudioOwnership final {
 public:
  explicit NativeAudioOwnership(bool sharedCapturePlayback = false)
      : sharedCapturePlayback_(sharedCapturePlayback) {}
  NativeAudioAcquireResult acquire(NativeAudioOwnerKind kind,
                                   uint64_t generation);
  bool release(NativeAudioOwnerKind kind, uint64_t generation);
  // A seam hands the lease from the generation it replaces to the one that
  // replaced it, in one step: the same owner kind, no moment in which the
  // device is unowned for another kind to take. False unless `from` holds it.
  bool rekey(NativeAudioOwnerKind kind, uint64_t from, uint64_t to);
  NativeAudioOwnershipSnapshot snapshot() const;

 private:
  mutable std::mutex mutex_;
  NativeAudioOwnerKind kind_{NativeAudioOwnerKind::None};
  uint64_t generation_{0};
  bool sharedCapturePlayback_{false};
  uint64_t captureGeneration_{0};
};

}  // namespace singz
