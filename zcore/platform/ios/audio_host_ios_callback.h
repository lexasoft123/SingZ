#pragma once

#include <TargetConditionals.h>

#if !TARGET_OS_IOS
#error "audio_host_ios_callback.h is only valid for iOS targets"
#endif

#include <AudioToolbox/AudioToolbox.h>
#include <mach/mach_time.h>

#include <array>
#include <atomic>
#include <cstdint>

#include <zcore/device/audio_host_callback.h>
#include <zcore/device/audio_host_render.h>
#include <zcore/device/audio_input_callback_gate.h>

namespace singz::detail {

struct IosAudioHostSessionSignals {
  std::atomic<uint32_t> pending{0};
  std::atomic<uint64_t> routeGeneration{1};
};

// Entire callback-owned state is prepared while admission is closed and stays
// immutable except for the explicitly callback-owned cursors and atomics.
// The control owner releases pointed-to storage only after the AudioUnit has
// been disposed and callbackInFlight has returned to zero.
struct IosAudioHostCallbackContext {
  AudioUnit unit{nullptr};
  AudioHostFormat format{};
  mach_timebase_info_data_t timebase{};
  AudioBufferList* inputList{nullptr};
  std::array<const float*, kAudioHostMaxChannels> inputPointers{};
  std::array<float*, kAudioHostMaxChannels> outputPointers{};
  IosAudioHostSessionSignals* signals{nullptr};
  uint64_t streamGeneration{0};
  uint64_t callbackSequence{0};
  uint64_t inputSourceFrame{0};
  uint64_t fallbackOutputFrame{0};
  AudioHostOutputTimeline outputTimeline{};
  AudioHostCallbackEndpoint endpoint{};
  AudioInputCallbackGate admission{};
  std::atomic<uint32_t> callbackInFlight{0};
  std::atomic<uint32_t> firstCallback{0};
  std::atomic<int32_t> callbackFailure{0};
};

OSStatus iosAudioHostRenderCallback(void* context,
                                    AudioUnitRenderActionFlags* flags,
                                    const AudioTimeStamp* timestamp,
                                    UInt32 bus, UInt32 frames,
                                    AudioBufferList* output) noexcept;

}  // namespace singz::detail
