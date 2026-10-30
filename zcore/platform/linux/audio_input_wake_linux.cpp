#include <zcore/device/audio_input_wake.h>

#include <sys/eventfd.h>
#include <poll.h>
#include <unistd.h>
#include <stdexcept>
#include <cerrno>

namespace singz {
struct AudioInputWake::Impl { int fd{-1}; };
AudioInputWake::AudioInputWake() : impl_(std::make_unique<Impl>()) {
  impl_->fd = eventfd(0, EFD_NONBLOCK | EFD_CLOEXEC);
  if (impl_->fd < 0) throw std::runtime_error("Cannot create capture wake eventfd");
}
AudioInputWake::~AudioInputWake() { ::close(impl_->fd); }
void AudioInputWake::signal() noexcept {
  const uint64_t value = 1;
  ssize_t written;
  do { written = ::write(impl_->fd, &value, sizeof(value)); }
  while (written < 0 && errno == EINTR);
  // EAGAIN means the eventfd already contains a pending wake.
}
void AudioInputWake::drain() {
  uint64_t value = 0;
  while (::read(impl_->fd, &value, sizeof(value)) > 0) {}
}
bool AudioInputWake::wait(uint32_t timeoutMs) {
  pollfd descriptor{impl_->fd, POLLIN, 0};
  const int result = ::poll(&descriptor, 1, int(timeoutMs));
  if (result <= 0 || !(descriptor.revents & POLLIN)) return false;
  drain(); return true;
}
}  // namespace singz
