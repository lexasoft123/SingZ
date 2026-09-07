#pragma once

#if !defined(__ANDROID__)
#error "audio_host_android_callback.h is only valid for Android targets"
#endif
#if defined(SINGZ_ANDROID_AUDIO_HOST_RT_COMPILE) && (defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND))
#error "Android AudioHost callback must compile without exceptions"
#endif
#if defined(SINGZ_ANDROID_AUDIO_HOST_RT_COMPILE) && (defined(__GXX_RTTI) || defined(_CPPRTTI))
#error "Android AudioHost callback must compile without RTTI"
#endif

#include <oboe/Oboe.h>

#include <array>
#include <atomic>
#include <cstdint>

#include "audio_host_android_callback_policy.h"
#include <zcore/device/audio_host_callback.h>
#include <zcore/device/audio_input_callback_gate.h>

namespace singz::detail {

enum class AndroidAudioHostRuntimeFailure : int32_t {
  None = 0,
  Disconnected = 1,
  StreamError = 2,
  CallbackTooLarge = 3,
  InvalidBuffer = 4,
  InputRead = 5,
  InputStarvation = 6,
  RouteChanged = 7,
};

// Off-RT Oboe CLOCK_MONOTONIC timestamp writer, callback-only reader. All
// fields are 32-bit atomics so publication is lock-free on armeabi-v7a.
struct AndroidAudioHostTimestampMailbox {
  std::atomic<uint32_t> sequence{0};
  std::atomic<uint32_t> frameLow{0};
  std::atomic<uint32_t> frameHigh{0};
  std::atomic<uint32_t> timeLow{0};
  std::atomic<uint32_t> timeHigh{0};
  std::atomic<uint32_t> sampledLow{0};
  std::atomic<uint32_t> sampledHigh{0};

  void reset() noexcept;
  bool publish(int64_t framePosition, int64_t hostTimeNs,
               uint64_t sampledAtNs) noexcept;
  AndroidAudioHostTimestampProjection project(
      uint64_t framePosition, uint32_t sampleRate,
      uint64_t callbackEntryNs) const noexcept;
};

struct AndroidAudioHostCallbackContext {
  oboe::AudioStream* inputStream{nullptr};
  oboe::AudioStream* outputStream{nullptr};
  AudioHostFormat format{};
  uint32_t inputEndpointChannels{0};
  uint32_t outputEndpointChannels{0};
  const uint32_t* inputChannelMap{nullptr};
  const int32_t* outputChannelMap{nullptr};
  float* inputInterleaved{nullptr};
  std::array<const float*, kAudioHostMaxChannels> inputPointers{};
  std::array<float*, kAudioHostMaxChannels> outputPointers{};
  const std::atomic<uint32_t>* routeGeneration{nullptr};
  const std::atomic<uint32_t>* inputDriverXruns{nullptr};
  const std::atomic<uint32_t>* outputDriverXruns{nullptr};
  uint32_t expectedRouteGeneration{0};
  uint64_t streamGeneration{0};
  uint64_t callbackSequence{0};
  uint64_t inputSourceFrame{0};
  uint64_t outputFrame{0};
  AudioHostOutputTimeline outputTimeline{};
  AndroidAudioHostDrainState drain{};
  uint32_t consecutiveEmptyInput{0};
  AndroidAudioHostDriverXrunState seenDriverXruns{};
  uint32_t inputTimestampHardware{0};
  uint32_t starvationLimitCallbacks{0};
  uint32_t firstRender{1};
  AndroidAudioHostTimestampMailbox inputTimestamp{};
  AndroidAudioHostTimestampMailbox outputTimestamp{};
  AudioHostCallbackEndpoint endpoint{};
  AudioInputCallbackGate admission{};
  std::atomic<uint32_t> inputOccupancyCurrent{0};
  std::atomic<uint32_t> inputOccupancyMinimum{UINT32_MAX};
  std::atomic<uint32_t> inputOccupancyMaximum{0};
  std::atomic<uint32_t> inputUnderflows{0};
  // Monotonic terminal publication token. RT increments it before publishing
  // the failure/closing admission, allowing control code to bracket a
  // precheck/commit/final-return window without taking pairMutex on RT.
  std::atomic<uint32_t> failureGeneration{0};
  std::atomic<int32_t> runtimeFailure{
      static_cast<int32_t>(AndroidAudioHostRuntimeFailure::None)};
};

struct AndroidAudioHostCallbackOwner {
  AndroidAudioHostCallbackContext* context{nullptr};
  void* control{nullptr};
  uint64_t pairEpoch{0};
  void (*observeError)(void*, uint64_t, oboe::AudioStream*,
                       oboe::Result) noexcept{nullptr};
  void (*beforeErrorClose)(void*, uint64_t, oboe::AudioStream*,
                           oboe::Result) noexcept{
      nullptr};
  void (*afterErrorClose)(void*, uint64_t, oboe::AudioStream*,
                          oboe::Result) noexcept{
      nullptr};
};

class AndroidAudioHostCallback final : public oboe::AudioStreamDataCallback,
                                       public oboe::AudioStreamErrorCallback {
 public:
  explicit AndroidAudioHostCallback(uint32_t outputEndpointChannels) noexcept
      : outputEndpointChannels_(outputEndpointChannels) {}

  void bind(AndroidAudioHostCallbackOwner* owner) noexcept {
    owner_.open(owner);
  }
  void beginClose() noexcept { owner_.beginClose(); }
  uint32_t inFlight() const noexcept { return owner_.inFlight(); }
  bool clearOwnerIfQuiescent() noexcept {
    return owner_.clearOwnerIfQuiescent();
  }

  oboe::DataCallbackResult onAudioReady(oboe::AudioStream* stream,
                                        void* audioData,
                                        int32_t numFrames) noexcept override;
  bool onError(oboe::AudioStream* stream,
               oboe::Result error) noexcept override;
  void onErrorBeforeClose(oboe::AudioStream* stream,
                          oboe::Result error) override;
  void onErrorAfterClose(oboe::AudioStream* stream,
                         oboe::Result error) override;

 private:
  AudioInputCallbackOwnerGate<AndroidAudioHostCallbackOwner> owner_;
  const uint32_t outputEndpointChannels_;
};

}  // namespace singz::detail
