// How the media layer reads a file: through a descriptor the product boundary
// authorized, and only with POSITIONED reads. Shared by every streaming source
// and by the format detector.
//
// Positioned, never seek-then-read, because two sources over one file is the
// ordinary case here — playback seeks around a lane while the waveform pass
// reads it straight through, on another thread — and `dup` shares one file
// position between them. A FILE* or a seek-then-read per source had them
// dragging each other's position about: measured before this was written, the
// second source could not even open, because the first one's read had already
// carried the shared cursor past the signature. On Windows the same race was
// what only MSVC on the field laptop could show.
#include "decoded_audio_internal.h"

#include <algorithm>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <fcntl.h>
#include <io.h>
#else
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace singz::media_internal {

// The same descriptor handover `decoded_audio.cpp` performs, and for the same
// reason: the media layer never takes a path, and the descriptor must be
// closed on every failure path rather than leaked into a half-open decoder.
int consumeAsDescriptor(OwnedFileDescriptor* descriptor) noexcept {
  if (descriptor == nullptr || !descriptor->valid()) return -1;
  const int raw = descriptor->release();
#if defined(_WIN32)
  if (_setmode(raw, _O_BINARY) == -1) {
    _close(raw);
    return -1;
  }
#endif
  return raw;
}

// One positioned read. The file position the kernel holds is never consulted
// and never moved by anything that relies on it.
//
// Windows has no pread, and `_dup` shares a file position exactly as POSIX
// dup does. `ReadFile` with an OVERLAPPED that carries the offset is Windows'
// positioned read: on a synchronous handle it reads at THAT offset regardless
// of the shared pointer (it also moves the pointer afterwards, which nothing
// here ever reads). The CRT descriptor's handle comes from `_get_osfhandle`; a
// dup'ed descriptor has a duplicated handle onto the same file object, which
// is what makes the offset-per-call the only position that matters.
// `ERROR_HANDLE_EOF` is a read past the end, i.e. zero bytes, the same answer
// pread gives.
int64_t readAt(int fd, void* buffer, size_t bytes, int64_t offset) noexcept {
  if (fd < 0) return -1;
#if defined(_WIN32)
  const HANDLE handle = reinterpret_cast<HANDLE>(_get_osfhandle(fd));
  if (handle == INVALID_HANDLE_VALUE) return -1;
  OVERLAPPED at{};
  at.Offset = static_cast<DWORD>(static_cast<uint64_t>(offset) & 0xFFFFFFFFULL);
  at.OffsetHigh = static_cast<DWORD>(static_cast<uint64_t>(offset) >> 32);
  DWORD got = 0;
  const DWORD want = static_cast<DWORD>(std::min<size_t>(bytes, 0x7FFFFFFFU));
  if (!ReadFile(handle, buffer, want, &got, &at)) {
    return GetLastError() == ERROR_HANDLE_EOF ? 0 : -1;
  }
  return static_cast<int64_t>(got);
#else
  return ::pread(fd, buffer, bytes, static_cast<off_t>(offset));
#endif
}

void closeRawDescriptor(int fd) noexcept {
  if (fd < 0) return;
#if defined(_WIN32)
  _close(fd);
#else
  ::close(fd);
#endif
}

int64_t fileLength(int fd) noexcept {
  if (fd < 0) return -1;
#if defined(_WIN32)
  // Asked of the handle, not walked with the cursor: the length of a file is
  // no reason to move a position a concurrent reader might share.
  const HANDLE handle = reinterpret_cast<HANDLE>(_get_osfhandle(fd));
  if (handle == INVALID_HANDLE_VALUE) return -1;
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(handle, &size)) return -1;
  return static_cast<int64_t>(size.QuadPart);
#else
  struct stat info {};
  if (::fstat(fd, &info) != 0) return -1;
  return static_cast<int64_t>(info.st_size);
#endif
}

namespace {

int64_t readDescriptorAt(void* context, uint64_t offset, unsigned char* buffer,
                         size_t bytes) noexcept {
  return readAt(*static_cast<const int*>(context), buffer, bytes, static_cast<int64_t>(offset));
}

}  // namespace

MediaByteSource descriptorByteSource(const int* fd, uint64_t length) noexcept {
  return MediaByteSource{const_cast<int*>(fd), &readDescriptorAt, length};
}

int64_t readFully(const MediaByteSource& source, uint64_t offset, unsigned char* buffer,
                  size_t bytes) noexcept {
  size_t got = 0;
  while (got < bytes) {
    const int64_t n = source.readAt(source.context, offset + got, buffer + got, bytes - got);
    if (n < 0) return -1;
    if (n == 0) break;
    got += static_cast<size_t>(n);
  }
  return static_cast<int64_t>(got);
}

}  // namespace singz::media_internal
