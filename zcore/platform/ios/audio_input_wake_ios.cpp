#include <zcore/device/audio_input_wake.h>

#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif

#if defined(__APPLE__) && TARGET_OS_IOS

#include <mach/mach.h>
#include <mach/semaphore.h>
#include <mach/task.h>

#include <chrono>
#include <thread>

namespace singz {

struct AudioInputWake::Impl {
  semaphore_t semaphore = SEMAPHORE_NULL;
};

AudioInputWake::AudioInputWake() : impl_(std::make_unique<Impl>()) {
  if (semaphore_create(mach_task_self(), &impl_->semaphore, SYNC_POLICY_FIFO, 0) !=
      KERN_SUCCESS)
    impl_->semaphore = SEMAPHORE_NULL;
}

AudioInputWake::~AudioInputWake() {
  if (impl_ && impl_->semaphore != SEMAPHORE_NULL)
    semaphore_destroy(mach_task_self(), impl_->semaphore);
}

void AudioInputWake::signal() noexcept {
  if (impl_ && impl_->semaphore != SEMAPHORE_NULL)
    (void)semaphore_signal(impl_->semaphore);
}

void AudioInputWake::drain() {
  if (!impl_ || impl_->semaphore == SEMAPHORE_NULL) return;
  const mach_timespec_t immediate{0, 0};
  while (semaphore_timedwait(impl_->semaphore, immediate) == KERN_SUCCESS) {}
}

bool AudioInputWake::wait(uint32_t timeoutMs) {
  if (!impl_ || impl_->semaphore == SEMAPHORE_NULL) {
    std::this_thread::sleep_for(std::chrono::milliseconds(timeoutMs));
    return false;
  }
  const mach_timespec_t timeout{
      static_cast<decltype(mach_timespec_t::tv_sec)>(timeoutMs / 1000),
      static_cast<decltype(mach_timespec_t::tv_nsec)>((timeoutMs % 1000) * 1000000u)};
  return semaphore_timedwait(impl_->semaphore, timeout) == KERN_SUCCESS;
}

}  // namespace singz

#endif  // __APPLE__ && TARGET_OS_IOS
