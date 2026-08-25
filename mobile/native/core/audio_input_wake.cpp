#include "audio_input_wake.h"

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#if (!defined(__APPLE__) || !TARGET_OS_OSX) && !defined(_WIN32)

#include <chrono>
#include <thread>

namespace singz {

struct AudioInputWake::Impl {};

AudioInputWake::AudioInputWake() : impl_(std::make_unique<Impl>()) {}
AudioInputWake::~AudioInputWake() = default;
void AudioInputWake::signal() {}
void AudioInputWake::drain() {}
bool AudioInputWake::wait(uint32_t timeoutMs) {
  std::this_thread::sleep_for(std::chrono::milliseconds(timeoutMs));
  return false;
}

}  // namespace singz

#endif
