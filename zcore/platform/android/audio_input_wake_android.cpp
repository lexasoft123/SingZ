#include <zcore/device/audio_input_wake.h>

#if defined(__ANDROID__)

#include <cerrno>
#include <chrono>
#include <cstdint>
#include <memory>
#include <thread>

#include <poll.h>
#include <sys/eventfd.h>
#include <unistd.h>

namespace singz {

struct AudioInputWake::Impl {
  int fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
};

AudioInputWake::AudioInputWake() : impl_(std::make_unique<Impl>()) {}
AudioInputWake::~AudioInputWake() {
  if (impl_ && impl_->fd >= 0) close(impl_->fd);
}

void AudioInputWake::signal() {
  if (!impl_ || impl_->fd < 0) return;
  const uint64_t one = 1;
  // eventfd is a fixed-size nonblocking kernel operation. EAGAIN only means
  // an unread wake is already pending, which is exactly the desired state.
  while (write(impl_->fd, &one, sizeof(one)) < 0 && errno == EINTR) {}
}

void AudioInputWake::drain() {
  if (!impl_ || impl_->fd < 0) return;
  uint64_t value = 0;
  while (read(impl_->fd, &value, sizeof(value)) < 0 && errno == EINTR) {}
}

bool AudioInputWake::wait(uint32_t timeoutMs) {
  const auto fallback = [timeoutMs] {
    // A failed eventfd/poll must retain the delivery loop's bounded polling
    // cadence. Returning immediately would turn a rare fd exhaustion or
    // driver error into a permanent CPU spin.
    if (timeoutMs > 0)
      std::this_thread::sleep_for(std::chrono::milliseconds(timeoutMs));
    else
      std::this_thread::yield();
    return false;
  };
  if (!impl_ || impl_->fd < 0) return fallback();
  pollfd descriptor{impl_->fd, POLLIN, 0};
  int result;
  do {
    result = poll(&descriptor, 1, static_cast<int>(timeoutMs));
  } while (result < 0 && errno == EINTR);
  if (result < 0 || (result > 0 &&
      (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)))) return fallback();
  if (result > 0 && (descriptor.revents & POLLIN)) {
    drain();
    return true;
  }
  return false;
}

}  // namespace singz

#endif
