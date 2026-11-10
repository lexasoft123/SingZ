// UTF-8 paths at the core's file boundary, on every platform.
//
// Public native paths are UTF-8. POSIX hands those bytes to the kernel as they
// are; the Windows CRT's narrow fopen/stat/remove/rename read them in the
// process ANSI code page instead, so a stem under C:\Users\Андрей\… fails to
// open there. Translate strictly at this boundary (invalid UTF-8 is EINVAL,
// never a lossy best effort) rather than changing the process-wide code page,
// which would also affect unrelated libraries.
//
// ONE definition: every core file opener goes through these, so the Windows
// shim cannot drift between copies.
#pragma once

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <string>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <cstring>
#include <limits>
#else
#include <sys/stat.h>
#endif

namespace singz {

#if defined(_WIN32)
// Strict UTF-8 -> UTF-16. False (errno = EINVAL) on an empty path, an
// embedded NUL or bytes that are not UTF-8.
inline bool utf8ToWide(const std::string& path, std::wstring* wide) {
  if (path.empty() || path.find('\0') != std::string::npos ||
      path.size() > static_cast<size_t>((std::numeric_limits<int>::max)())) {
    errno = EINVAL;
    return false;
  }
  const int bytes = static_cast<int>(path.size());
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), bytes,
                                        nullptr, 0);
  if (count <= 0) {
    errno = EINVAL;
    return false;
  }
  wide->assign(static_cast<size_t>(count), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(), bytes, wide->data(),
                          count) != count) {
    errno = EINVAL;
    return false;
  }
  return true;
}
#endif

inline std::FILE* openUtf8(const std::string& path, const char* mode) {
#if defined(_WIN32)
  std::wstring wide;
  if (!utf8ToWide(path, &wide)) return nullptr;
  const std::wstring wideMode(mode, mode + std::strlen(mode));
  return _wfopen(wide.c_str(), wideMode.c_str());
#else
  return std::fopen(path.c_str(), mode);
#endif
}

inline int removeUtf8(const std::string& path) {
#if defined(_WIN32)
  std::wstring wide;
  if (!utf8ToWide(path, &wide)) return -1;
  return _wremove(wide.c_str());
#else
  return std::remove(path.c_str());
#endif
}

inline int renameUtf8(const std::string& from, const std::string& to) {
#if defined(_WIN32)
  std::wstring wideFrom, wideTo;
  if (!utf8ToWide(from, &wideFrom) || !utf8ToWide(to, &wideTo)) return -1;
  return _wrename(wideFrom.c_str(), wideTo.c_str());
#else
  return std::rename(from.c_str(), to.c_str());
#endif
}

// True when the path exists; its size in *size when asked.
inline bool statUtf8(const std::string& path, int64_t* size = nullptr) {
#if defined(_WIN32)
  std::wstring wide;
  if (!utf8ToWide(path, &wide)) return false;
  struct _stat64 st;
  if (_wstat64(wide.c_str(), &st) != 0) return false;
#else
  struct stat st;
  if (::stat(path.c_str(), &st) != 0) return false;
#endif
  if (size != nullptr) *size = static_cast<int64_t>(st.st_size);
  return true;
}

}  // namespace singz
