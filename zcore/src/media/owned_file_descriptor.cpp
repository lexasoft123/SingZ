#include <zcore/media/decoded_audio.h>

#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

namespace singz {
namespace {

void closeOwnedDescriptor(int descriptor) noexcept {
  if (descriptor < 0) return;
#if defined(_WIN32)
  (void)_close(descriptor);
#else
  (void)::close(descriptor);
#endif
}

}  // namespace

OwnedFileDescriptor::OwnedFileDescriptor(int descriptor) noexcept
    : descriptor_(descriptor) {}

OwnedFileDescriptor::~OwnedFileDescriptor() { reset(); }

OwnedFileDescriptor::OwnedFileDescriptor(OwnedFileDescriptor&& other) noexcept
    : descriptor_(other.release()) {}

OwnedFileDescriptor& OwnedFileDescriptor::operator=(
    OwnedFileDescriptor&& other) noexcept {
  if (this != &other) reset(other.release());
  return *this;
}

bool OwnedFileDescriptor::valid() const noexcept { return descriptor_ >= 0; }
int OwnedFileDescriptor::get() const noexcept { return descriptor_; }
int OwnedFileDescriptor::release() noexcept {
  const int result = descriptor_;
  descriptor_ = -1;
  return result;
}
void OwnedFileDescriptor::reset(int descriptor) noexcept {
  if (descriptor_ == descriptor) return;
  closeOwnedDescriptor(descriptor_);
  descriptor_ = descriptor;
}

}  // namespace singz
