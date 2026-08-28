#pragma once

#include <cstdint>
#include <mutex>

namespace singz {

enum class NativeAudioOwnerKind : uint32_t {
  None,
  Capture,
  Monitor,
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

// Addon-wide control-domain arbitration. Capture analysis and full-duplex
// monitoring must never own the native microphone at the same time.
class NativeAudioOwnership final {
 public:
  NativeAudioAcquireResult acquire(NativeAudioOwnerKind kind,
                                   uint64_t generation);
  bool release(NativeAudioOwnerKind kind, uint64_t generation);
  NativeAudioOwnershipSnapshot snapshot() const;

 private:
  mutable std::mutex mutex_;
  NativeAudioOwnerKind kind_{NativeAudioOwnerKind::None};
  uint64_t generation_{0};
};

// A failed monitor begin may still retain its prepared graph and generation
// for teardown retry. In that case the addon-wide lease must remain held so a
// capture owner cannot enter while the monitor quarantine is live. Returns
// true only when the failed begin's lease was actually released.
bool releaseUnretainedMonitorBeginLease(
    NativeAudioOwnership* ownership, uint64_t failedGeneration,
    uint64_t retainedMonitorGeneration);

// Both the public end call and the N-API environment cleanup hook use this
// rule: a failed end still owns quarantined native state, so only a successful
// end may release the addon-wide monitor lease.
bool releaseMonitorLeaseAfterEnd(NativeAudioOwnership* ownership,
                                 uint64_t generation, bool endedCleanly);

}  // namespace singz
