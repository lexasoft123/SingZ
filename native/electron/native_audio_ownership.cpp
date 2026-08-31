#include "native_audio_ownership.h"

namespace singz {

NativeAudioAcquireResult NativeAudioOwnership::acquire(
    NativeAudioOwnerKind kind, uint64_t generation) {
  if (kind == NativeAudioOwnerKind::None || generation == 0)
    return NativeAudioAcquireResult::InvalidGeneration;
  std::lock_guard<std::mutex> lock(mutex_);
  if (kind_ != NativeAudioOwnerKind::None)
    return NativeAudioAcquireResult::Busy;
  kind_ = kind;
  generation_ = generation;
  return NativeAudioAcquireResult::Acquired;
}

bool NativeAudioOwnership::release(NativeAudioOwnerKind kind,
                                   uint64_t generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (kind == NativeAudioOwnerKind::None || kind_ != kind ||
      generation == 0 || generation_ != generation)
    return false;
  kind_ = NativeAudioOwnerKind::None;
  generation_ = 0;
  return true;
}

NativeAudioOwnershipSnapshot NativeAudioOwnership::snapshot() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return {kind_, generation_};
}

bool releaseUnretainedMonitorBeginLease(
    NativeAudioOwnership* ownership, uint64_t failedGeneration,
    uint64_t retainedMonitorGeneration) {
  if (ownership == nullptr || failedGeneration == 0 ||
      retainedMonitorGeneration == failedGeneration)
    return false;
  return ownership->release(NativeAudioOwnerKind::Monitor, failedGeneration);
}

bool releaseMonitorLeaseAfterEnd(NativeAudioOwnership* ownership,
                                 uint64_t generation, bool endedCleanly) {
  if (!endedCleanly || ownership == nullptr || generation == 0) return false;
  return ownership->release(NativeAudioOwnerKind::Monitor, generation);
}

}  // namespace singz
