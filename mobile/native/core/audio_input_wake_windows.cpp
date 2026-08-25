#include "audio_input_wake.h"

#if defined(_WIN32)

#include <windows.h>

#include <chrono>
#include <thread>

namespace singz {

struct AudioInputWake::Impl {
  HANDLE event = nullptr;
};

AudioInputWake::AudioInputWake() : impl_(std::make_unique<Impl>()) {
  impl_->event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
}

AudioInputWake::~AudioInputWake() {
  if (impl_ && impl_->event) CloseHandle(impl_->event);
}

void AudioInputWake::signal() {
  if (impl_ && impl_->event) (void)SetEvent(impl_->event);
}

void AudioInputWake::drain() {
  if (impl_ && impl_->event)
    while (WaitForSingleObject(impl_->event, 0) == WAIT_OBJECT_0) {}
}

bool AudioInputWake::wait(uint32_t timeoutMs) {
  if (!impl_ || !impl_->event) {
    std::this_thread::sleep_for(std::chrono::milliseconds(timeoutMs));
    return false;
  }
  return WaitForSingleObject(impl_->event, timeoutMs) == WAIT_OBJECT_0;
}

}  // namespace singz

#endif
