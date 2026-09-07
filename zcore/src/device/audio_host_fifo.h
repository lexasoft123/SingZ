#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

#include <zcore/device/audio_host_render.h>

namespace singz::detail {

struct AudioHostCaptureSpan {
  uint64_t sourceFrame{0};
  uint64_t sampleHostTimeNs{0};
  uint32_t frames{0};
  uint32_t discontinuity{AudioHostDiscontinuityNone};
  bool timestampValid{false};
  bool timestampHardware{false};
};

struct AudioHostFifoRead {
  uint32_t framesRead{0};
  uint64_t sourceFrame{0};
  uint64_t sampleHostTimeNs{0};
  uint32_t discontinuity{AudioHostDiscontinuityNone};
  bool timestampValid{false};
  bool timestampHardware{false};
};

// Prepared off the audio threads, then used by exactly one producer and one
// consumer. Its hot methods allocate nothing and use only lock-free uint32
// atomics so the same contract remains valid on 32-bit mobile builds.
class AudioHostPlanarFifo final {
 public:
  bool prepare(uint32_t channels, uint32_t capacityFrames);
  void reset() noexcept;

  bool writeInterleavedFloat(const float* input, uint32_t endpointChannels,
                             const uint32_t* channelMap, uint32_t frames,
                             const AudioHostCaptureSpan& span,
                             bool silent) noexcept;
  AudioHostFifoRead read(float* const* output, uint32_t frames,
                         double sampleRate,
                         bool countUnderflow = true) noexcept;

  uint32_t channels() const noexcept { return channels_; }
  uint32_t capacityFrames() const noexcept { return capacityFrames_; }
  uint32_t currentFrames() const noexcept;
  uint32_t minimumFrames() const noexcept;
  uint32_t maximumFrames() const noexcept;
  uint32_t underflows() const noexcept;
  uint32_t overflows() const noexcept;

  // Empty-queue cursor injection for deterministic unsigned rollover tests.
  // This private-header seam changes prepared FIFO state only; it is not part
  // of zcore's installed/public AudioHost API.
  void seedEmptyCursorsForTest(uint32_t dataCursor,
                               uint32_t spanCursor) noexcept;

 private:
  void updateMaximum(uint32_t value) noexcept;
  void updateMinimum(uint32_t value) noexcept;

  uint32_t channels_{0};
  uint32_t capacityFrames_{0};
  std::vector<float> samples_;
  std::vector<AudioHostCaptureSpan> spans_;
  alignas(64) std::atomic<uint32_t> dataWrite_{0};
  alignas(64) std::atomic<uint32_t> dataRead_{0};
  alignas(64) std::atomic<uint32_t> spanWrite_{0};
  alignas(64) std::atomic<uint32_t> spanRead_{0};
  std::atomic<uint32_t> minimumFrames_{UINT32_MAX};
  std::atomic<uint32_t> maximumFrames_{0};
  std::atomic<uint32_t> underflows_{0};
  std::atomic<uint32_t> overflows_{0};
  uint32_t readSpanOffset_{0};
  bool nextWriteDiscontinuous_{false};
};

}  // namespace singz::detail
