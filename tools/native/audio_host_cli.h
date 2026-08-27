#pragma once

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <limits>

#include <zcore/device/audio_host.h>

namespace singz::tools {

inline const char* audioHostStateName(AudioHostState state) noexcept {
  switch (state) {
    case AudioHostState::Closed: return "closed";
    case AudioHostState::Open: return "open";
    case AudioHostState::Running: return "running";
    case AudioHostState::Stopped: return "stopped";
    case AudioHostState::DeviceLost: return "device-lost";
    case AudioHostState::Error: return "error";
    case AudioHostState::Unsupported: return "unsupported";
  }
  return "unknown";
}

inline int audioHostRunExitCode(const AudioHostStatus& status) noexcept {
  return status.state == AudioHostState::Stopped && status.callbacks != 0 &&
                 status.renderFailures == 0
             ? 0
             : 4;
}

inline bool parseAudioHostUint32(const char* text, uint32_t fallback,
                                 uint32_t* result) noexcept {
  if (result == nullptr) return false;
  if (text == nullptr) {
    *result = fallback;
    return true;
  }
  if (*text == '\0') return false;
  for (const char* digit = text; *digit != '\0'; ++digit) {
    if (*digit < '0' || *digit > '9') return false;
  }
  errno = 0;
  char* end = nullptr;
  const unsigned long long parsed = std::strtoull(text, &end, 10);
  if (errno == ERANGE || end == nullptr || *end != '\0' ||
      parsed > std::numeric_limits<uint32_t>::max()) {
    return false;
  }
  *result = static_cast<uint32_t>(parsed);
  return true;
}

}  // namespace singz::tools
