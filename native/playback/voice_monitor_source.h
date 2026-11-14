#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <zcore/audio/audio_input_producer.h>
#include <zcore/device/audio_host_render.h>
#include <zcore/device/audio_input_backend.h>
#include <zcore/routing/audio_history.h>

namespace singz {

// SINGZ_MONITOR_SOURCE_RT_BEGIN
inline constexpr uint32_t kVoiceMonitorHistoryFrames = 32768;
inline constexpr uint32_t kVoiceMonitorQuantum = 256;
inline constexpr uint32_t kVoiceMonitorMaximumCaptureFrames = 16384;
inline constexpr zcore::routing::SampleClockPhaseConfig kVoiceMonitorPhaseConfig{2, 8};

// All periods, ages, lookback, jitter and the result are in SOURCE frames,
// except outputPeriod/outputLead, which are in OUTPUT frames.
// Capture age is first-sample to publication; output lead is callback entry to
// presentation. Zero means invalid/too large; absent timing uses period floors.
uint32_t voiceMonitorQueueFloor(double sourceRate, double outputRate,
    uint32_t outputPeriod, uint32_t inputPeriod, uint32_t lookback = 192,
    uint32_t jitterMargin = 128, uint32_t quantum = kVoiceMonitorQuantum,
    uint32_t captureAge = 0, uint32_t outputLead = 0) noexcept;
uint32_t voiceMonitorPresentationLead(const AudioHostRenderBlock&) noexcept;

// One callback owns this state; only its returned estimate is published through
// the owner's atomic. Two half-second windows retain the third-largest sample:
// isolated wakes cannot raise it, sustained timing changes do, and old timing
// expires within one second. Reset only after that callback has joined.
class VoiceMonitorTimingWindow {
 public:
  void reset() noexcept;
  uint32_t observe(uint32_t frames, uint32_t period, uint64_t ns, uint32_t deviceFrames = 0) noexcept;
 private:
  std::array<uint32_t, 3> largest_{};
  uint32_t previous_{}, warmup_{}, estimate_{};
  uint64_t startNs_{};
};

class VoiceMonitorOutputClock {
 public:
  double observe(uint64_t frame, uint64_t ns, uint32_t frames, double nominal,
                 bool discontinuity = false) noexcept;
  void reset() noexcept;
 private:
  uint64_t previousFrame_{}, previousNs_{}, originFrame_{}, originNs_{}, recentFrame_{}, recentNs_{};
  uint32_t previousFrames_{};
  double nominalRate_{};
};

// One serial output callback owns each reader; the source supports independent
// readers. Reset on detach/route change, only after that reader has joined.
struct VoiceMonitorReader {
  VoiceMonitorOutputClock clock;
  zcore::routing::AudioReadCursor cursor;
};
struct VoiceMonitorSourceStats {
  uint64_t publishedBlocks{}, publishedFrames{}, droppedBlocks{}, droppedFrames{}, missingFrames{};
  uint64_t estimatedTimestampBlocks{}, unknownTimestampBlocks{};
  uint64_t phaseCorrections{}, correctedSamples{}, rejectedIntervals{}, discontinuities{};
  uint64_t maximumCaptureAgeFrames{}; // Robust window estimate, not a lifetime maximum.
};

class VoiceMonitorSource {
 public:
  VoiceMonitorSource();
  // Control domain, with capture joined. Storage and readers survive stop.
  void prepare(double sourceRate, uint32_t inputPeriod, uint32_t inputDeviceFrames = 0) noexcept;
  void stop() noexcept;
  bool publish(const float*, uint32_t, uint64_t, AudioInputTimestampQuality,
               AudioInputSourcePosition = {}, uint64_t callbackHostTimeNs = 0) noexcept;
  // Mono, zero-filled on absent history. queueFrames is explicit source-frame
  // delay and must meet queueFloor(); zero requests that floor. Missing audio
  // is counted silence, never an output-host failure. capacity bounds writes.
  // A common client passes its already computed floor to keep one snapshot
  // across a concurrent capture publication; direct callers may omit it.
  zcore::routing::AudioReadResult render(const AudioHostRenderBlock&, float* mono,
      uint32_t capacity, uint32_t queueFrames, VoiceMonitorReader&, uint32_t preparedFloor = 0) noexcept;
  uint32_t queueFloor(double outputRate, uint32_t outputPeriod, uint32_t outputLead = 0) const noexcept;
  double sourceRate() const noexcept { return rate_.load(std::memory_order_relaxed); }
  uint32_t inputPeriod() const noexcept { return inputPeriod_.load(std::memory_order_relaxed); }
  VoiceMonitorSourceStats stats() const noexcept;
 private:
  zcore::routing::AudioHistory history_;
  std::atomic<double> rate_{0};
  std::atomic<uint32_t> inputPeriod_{0};
  std::atomic<uint32_t> captureAgeFrames_{0};
  uint32_t inputDeviceFrames_{0}; // Control writes only with capture joined.
  VoiceMonitorTimingWindow captureAgeWindow_; // Capture-callback owned.
  std::atomic<uint64_t> publishedBlocks_{0}, publishedFrames_{0}, droppedBlocks_{0}, droppedFrames_{0}, missingFrames_{0};
  std::atomic<uint64_t> estimated_{0}, unknown_{0};
};

// Prepared on control; never changed until backend callbacks have joined.
// The delivery buffer is borrowed, immutable and independent of the history.
struct
#if defined(__GNUC__) || defined(__clang__)
__attribute__((visibility("hidden")))
#endif
VoiceMonitorCaptureTap {
  AudioInputRingProducer delivery;
  VoiceMonitorSource* monitor{};
  static bool push(void*, const float*, uint32_t, uint64_t, uint64_t,
                   AudioInputTimestampQuality) noexcept;
  static bool pushWithPosition(void*, const float*, uint32_t, uint64_t, uint64_t,
                   AudioInputTimestampQuality, AudioInputSourcePosition) noexcept;
};
// SINGZ_MONITOR_SOURCE_RT_END

// Control/delivery owner. One backend feeds both consumers, with no wake-up
// syscall in capture. Delivery polls its bounded SPSC ring off the audio thread.
// These methods are control-only; never call them from a delivery sink.
enum class VoiceCaptureUser : uint8_t { Arm, Take, Monitor };
class VoiceMonitorCapture {
 public:
  using BackendFactory = std::unique_ptr<AudioInputBackend> (*)();
  explicit VoiceMonitorCapture(BackendFactory = createPlatformAudioInputBackend);
  ~VoiceMonitorCapture();
  VoiceMonitorCapture(const VoiceMonitorCapture&) = delete;
  VoiceMonitorCapture& operator=(const VoiceMonitorCapture&) = delete;
  // Active-route joins preserve its opening buffer policy; only device,
  // channel and delivery-ring identity must match, so toggles cannot retune takes.
  AudioInputResult retain(VoiceCaptureUser, const AudioInputConfig&,
      AudioInputSink = {}, const std::vector<AudioInputDevice>* inventory = nullptr);
  bool retainExisting(VoiceCaptureUser);
  void release(VoiceCaptureUser, bool retainPrepared = false);
  // Discard an idle prepared backend without disturbing any retained user.
  void releasePrepared();
  // Control transaction with ALL output readers joined. Take capture cannot
  // pause: its file/timeline must finish before changing the physical period.
  bool pauseForBufferChange();
  AudioInputResult resumeAfterBufferChange(uint32_t frames);
  // Waits for any active delivery invocation before replacing its sink.
  void setDeliverySink(AudioInputSink);
  void synchronizeDelivery(const std::function<void()>&);
  uint32_t users(VoiceCaptureUser) const;
  AudioInputState state() const noexcept;
  AudioInputStats stats() const;
  AudioInputResult openingResult() const;
  std::string lastError() const;
  VoiceMonitorSource& source() noexcept;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
// The first call selects the factory; production callers use the real default.
VoiceMonitorCapture& sharedVoiceMonitorCapture(
    VoiceMonitorCapture::BackendFactory = createPlatformAudioInputBackend);
} // namespace singz
