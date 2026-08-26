#pragma once

#include <cstdint>
#include <memory>

namespace singz {

enum class AudioInputTimestampQuality : uint8_t {
  Unknown = 0,
  Hardware = 1,
  CallbackEstimate = 2,
};

struct AudioInputBlockView {
  uint64_t sequence = 0;
  uint64_t sampleHostTimeNs = 0;
  uint64_t callbackHostTimeNs = 0;
  AudioInputTimestampQuality timestampQuality =
      AudioInputTimestampQuality::Unknown;
  double sampleRate = 0;
  const float* mono = nullptr;
  uint32_t frames = 0;
};

// Preallocated SPSC callback transport. push() is the hardware-callback API;
// it allocates nothing, takes no lock and performs no analysis. The remaining
// methods belong to the ordinary delivery thread.
class AudioInputRing {
 public:
  AudioInputRing(uint32_t blocks, uint32_t maxFrames);
  ~AudioInputRing();
  AudioInputRing(const AudioInputRing&) = delete;
  AudioInputRing& operator=(const AudioInputRing&) = delete;

  bool valid() const;
  bool push(const float* mono, uint32_t frames, uint64_t sampleHostTimeNs,
            uint64_t callbackHostTimeNs = 0,
            AudioInputTimestampQuality timestampQuality =
                AudioInputTimestampQuality::Unknown);
  bool peek(AudioInputBlockView& out, double sampleRate);
  void consume();
  uint64_t overruns() const;
  uint32_t capacity() const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace singz
