#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace singz {

struct DecodedAudioResult;

// A descriptor opened and authorized by the product boundary. Preparation
// consumes this object and closes it on every success/failure/cancellation
// path. The media layer never needs a path and never retains an OS resource.
// On Windows this is a CRT descriptor (the shape accepted by _fdopen), not a
// raw HANDLE.
class OwnedFileDescriptor {
 public:
  OwnedFileDescriptor() noexcept = default;
  explicit OwnedFileDescriptor(int descriptor) noexcept;
  ~OwnedFileDescriptor();
  OwnedFileDescriptor(const OwnedFileDescriptor&) = delete;
  OwnedFileDescriptor& operator=(const OwnedFileDescriptor&) = delete;
  OwnedFileDescriptor(OwnedFileDescriptor&& other) noexcept;
  OwnedFileDescriptor& operator=(OwnedFileDescriptor&& other) noexcept;

  [[nodiscard]] bool valid() const noexcept;
  [[nodiscard]] int get() const noexcept;
  [[nodiscard]] int release() noexcept;
  void reset(int descriptor = -1) noexcept;

 private:
  int descriptor_ = -1;
};

using DecodeCancelFn = bool (*)(void*) noexcept;

struct DecodeCancellation {
  void* context = nullptr;
  DecodeCancelFn requested = nullptr;

  [[nodiscard]] bool isRequested() const noexcept {
    return requested != nullptr && requested(context);
  }
};

struct DecodedAudioPrepareOptions {
  // Zero keeps the source rate. A non-zero rate resamples before publication;
  // duration maps to the nearest output frame with half frames rounded up.
  uint32_t requiredSampleRate = 0;
  uint32_t maximumChannels = 64;
  uint64_t maximumFrames = 1ull << 32;
  // Logical size bound for the immutable planar float samples that may be
  // published. Preparation and optional resampling use additional transient
  // ordinary-thread storage, so this is not a peak-memory limit.
  size_t maximumDecodedBytes = size_t{1} << 30;
  // Conservative sum of planned float payloads simultaneously alive during
  // resampling (source/destination planes, interleaved output, filter,
  // history, work and block buffers). Allocator/container bookkeeping is not
  // included. Non-resampled publication still observes this bound. Reserve
  // allocations are not preemptible; zero-initialization, conversion and
  // resampler work are divided into bounded slices between cancellation polls.
  size_t maximumWorkingBytes = size_t{1} << 31;
  // Reduced numerator/denominator and total multiply/filter work limits are
  // checked before the legacy resampler is constructed. The per-poll limit
  // separately caps multiply-accumulate work in every process() invocation,
  // including the first call's primed history; callers may lower it but may
  // not raise it above the default implementation cap.
  uint32_t maximumReducedRateFactor = 4096;
  uint64_t maximumResampleOperations = 1ull << 34;
  uint64_t maximumResampleOperationsPerPoll = 1ull << 18;
};

enum class DecodedAudioStatus : uint32_t {
  Ok = 0,
  InvalidArgument,
  Cancelled,
  IoError,
  UnsupportedFormat,
  MalformedData,
  LimitExceeded,
  ResourceExhausted,
};

// Immutable after construction. The outer shared owner belongs to the future
// playback session; callback-side zdsp processors borrow channelData() only
// while that owner is guaranteed to remain alive.
class DecodedAudio final {
 public:
  DecodedAudio(const DecodedAudio&) = delete;
  DecodedAudio& operator=(const DecodedAudio&) = delete;

  [[nodiscard]] uint32_t sampleRate() const noexcept { return sampleRate_; }
  [[nodiscard]] uint32_t channelCount() const noexcept {
    return static_cast<uint32_t>(channels_.size());
  }
  [[nodiscard]] uint64_t frameCount() const noexcept { return frameCount_; }
  [[nodiscard]] size_t retainedBytes() const noexcept {
    return static_cast<size_t>(frameCount_) * channels_.size() * sizeof(float);
  }
  [[nodiscard]] const float* channelData(uint32_t channel) const noexcept;

 private:
  friend struct DecodedAudioResult;
  friend DecodedAudioResult prepareDecodedAudio(
      OwnedFileDescriptor, const DecodedAudioPrepareOptions&,
      DecodeCancellation) noexcept;

  DecodedAudio(uint32_t sampleRate, uint64_t frameCount,
               std::vector<std::vector<float>> channels) noexcept;

  uint32_t sampleRate_ = 0;
  uint64_t frameCount_ = 0;
  std::vector<std::vector<float>> channels_;
};

struct DecodedAudioResult {
  DecodedAudioStatus status = DecodedAudioStatus::InvalidArgument;
  // Null for every non-Ok status. Work-in-progress storage is never exposed.
  std::shared_ptr<const DecodedAudio> audio;

  [[nodiscard]] bool ok() const noexcept {
    return status == DecodedAudioStatus::Ok && audio != nullptr;
  }
};

[[nodiscard]] DecodedAudioResult prepareDecodedAudio(
    OwnedFileDescriptor descriptor,
    const DecodedAudioPrepareOptions& options = {},
    DecodeCancellation cancellation = {}) noexcept;

// Durable capability evidence for native artifact inspection.
[[nodiscard]] const char* decodedAudioCapabilityTag() noexcept;

}  // namespace singz
