#pragma once

#include <atomic>
#include <cstdint>

namespace singz {

struct AudioInputTimestampProjection {
  uint64_t sampleHostTimeNs = 0;
  bool usedHardwareAnchor = false;
};

// Shared policy for callback-driven backends with an optional OS-provided
// first-sample timestamp. Invalid/missing hardware timestamps use a bounded
// callback-entry-minus-buffer-duration estimate; a nonzero callback clock is
// clamped to 1 ns on underflow so downstream timelines remain initialized.
uint64_t audioInputCallbackEntryFallback(uint64_t callbackEntryNs,
                                         uint32_t blockFrames,
                                         double sampleRate);
AudioInputTimestampProjection resolveAudioInputTimestamp(
    bool hardwareTimestampValid, uint64_t hardwareTimestampNs,
    uint64_t callbackEntryNs, uint32_t blockFrames, double sampleRate);

class AudioInputTimestampQueryGate {
 public:
  void open() { accepting_.store(true, std::memory_order_release); }
  void beginClose() { accepting_.store(false, std::memory_order_release); }
  bool enter() {
    if (!accepting_.load(std::memory_order_acquire)) return false;
    inFlight_.fetch_add(1, std::memory_order_acq_rel);
    if (accepting_.load(std::memory_order_acquire)) return true;
    inFlight_.fetch_sub(1, std::memory_order_release);
    return false;
  }
  void leave() { inFlight_.fetch_sub(1, std::memory_order_release); }
  uint32_t inFlight() const { return inFlight_.load(std::memory_order_acquire); }
  bool accepting() const { return accepting_.load(std::memory_order_acquire); }

 private:
  std::atomic<bool> accepting_{false};
  std::atomic<uint32_t> inFlight_{0};
};

class AudioInputTimestampQueryScope {
 public:
  explicit AudioInputTimestampQueryScope(AudioInputTimestampQueryGate& gate)
      : gate_(gate), entered_(gate_.enter()) {}
  ~AudioInputTimestampQueryScope() {
    if (entered_) gate_.leave();
  }
  explicit operator bool() const { return entered_; }

 private:
  AudioInputTimestampQueryGate& gate_;
  bool entered_;
};

// Lock-free bridge from a non-real-time hardware timestamp sampler to the
// input callback. Values are split into 32-bit atomics so reads stay lock-free
// on armeabi-v7a as well as 64-bit devices. A bounded sequence retry falls
// back instead of spinning if it collides with the sampler's publication.
class AudioInputTimestampProjector {
 public:
  void reset();
  bool publish(int64_t framePosition, int64_t frameTimeNs,
               uint64_t sampledAtNs);
  AudioInputTimestampProjection project(int64_t blockStartFrame,
                                        uint32_t blockFrames,
                                        int32_t sampleRate,
                                        uint64_t callbackEntryNs) const;

 private:
  struct Snapshot {
    int64_t framePosition = 0;
    int64_t frameTimeNs = 0;
    uint64_t sampledAtNs = 0;
  };

  bool snapshot(Snapshot& out) const;
  static uint64_t joinUnsigned(uint32_t low, uint32_t high);
  static int64_t joinSigned(uint32_t low, uint32_t high);

  std::atomic<uint32_t> sequence_{0};
  std::atomic<uint32_t> frameLow_{0};
  std::atomic<uint32_t> frameHigh_{0};
  std::atomic<uint32_t> timeLow_{0};
  std::atomic<uint32_t> timeHigh_{0};
  std::atomic<uint32_t> sampledLow_{0};
  std::atomic<uint32_t> sampledHigh_{0};
};

}  // namespace singz
