#include "native_audio_ownership.h"

namespace singz {

NativeAudioAcquireResult NativeAudioOwnership::acquire(
    NativeAudioOwnerKind kind, uint64_t generation) {
  if (kind == NativeAudioOwnerKind::None || generation == 0)
    return NativeAudioAcquireResult::InvalidGeneration;
  std::lock_guard<std::mutex> lock(mutex_);
  if (sharedCapturePlayback_ && kind == NativeAudioOwnerKind::Capture) {
    if (captureGeneration_ != 0 || kind_ == NativeAudioOwnerKind::Monitor)
      return NativeAudioAcquireResult::Busy;
    captureGeneration_ = generation;
    return NativeAudioAcquireResult::Acquired;
  }
  if (kind == NativeAudioOwnerKind::Monitor && captureGeneration_ != 0)
    return NativeAudioAcquireResult::Busy;
  if (kind_ != NativeAudioOwnerKind::None)
    return NativeAudioAcquireResult::Busy;
  kind_ = kind;
  generation_ = generation;
  return NativeAudioAcquireResult::Acquired;
}

bool NativeAudioOwnership::release(NativeAudioOwnerKind kind,
                                   uint64_t generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (sharedCapturePlayback_ && kind == NativeAudioOwnerKind::Capture) {
    if (generation == 0 || captureGeneration_ != generation) return false;
    captureGeneration_ = 0;
    return true;
  }
  if (kind == NativeAudioOwnerKind::None || kind_ != kind ||
      generation == 0 || generation_ != generation)
    return false;
  kind_ = NativeAudioOwnerKind::None;
  generation_ = 0;
  return true;
}

bool NativeAudioOwnership::rekey(NativeAudioOwnerKind kind, uint64_t from,
                                 uint64_t to) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (sharedCapturePlayback_ && kind == NativeAudioOwnerKind::Capture) {
    if (from == 0 || to == 0 || from == to || captureGeneration_ != from)
      return false;
    captureGeneration_ = to;
    return true;
  }
  if (kind == NativeAudioOwnerKind::None || kind_ != kind || from == 0 ||
      to == 0 || from == to || generation_ != from)
    return false;
  generation_ = to;
  return true;
}

NativeAudioOwnershipSnapshot NativeAudioOwnership::snapshot() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return kind_ == NativeAudioOwnerKind::None && captureGeneration_ != 0
      ? NativeAudioOwnershipSnapshot{NativeAudioOwnerKind::Capture, captureGeneration_}
      : NativeAudioOwnershipSnapshot{kind_, generation_};
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
