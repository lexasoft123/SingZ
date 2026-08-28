#pragma once

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <utility>
#include <vector>

#include <zcore/device/audio_host.h>

namespace singz::tools {

inline const char* audioHostAccessModeName(AudioHostAccessMode mode) noexcept {
  return mode == AudioHostAccessMode::Exclusive ? "exclusive" : "shared";
}

inline const char* audioHostDirectionName(
    AudioHostEndpointDirection direction) noexcept {
  switch (direction) {
    case AudioHostEndpointDirection::Duplex: return "duplex";
    case AudioHostEndpointDirection::Input: return "input";
    case AudioHostEndpointDirection::Output: return "output";
  }
  return "unknown";
}

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
                 status.xruns == 0 && status.deadlineMisses == 0 &&
                 status.invalidCallbacks == 0 &&
                 status.renderFailures == 0 &&
                 status.diagnostics.fifoUnderflows == 0 &&
                 status.diagnostics.fifoOverflows == 0 &&
                 status.diagnostics.startupInputZeroFrames == 0
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

inline bool parseAudioHostChannelList(const char* text,
                                      std::vector<uint32_t>* result) {
  if (text == nullptr || result == nullptr || *text == '\0') return false;
  std::vector<uint32_t> parsed;
  const char* item = text;
  for (;;) {
    const char* end = item;
    while (*end != '\0' && *end != ',') ++end;
    if (end == item) return false;
    uint64_t value = 0;
    for (const char* digit = item; digit != end; ++digit) {
      if (*digit < '0' || *digit > '9') return false;
      value = value * 10u + static_cast<uint64_t>(*digit - '0');
      if (value > std::numeric_limits<uint32_t>::max()) return false;
    }
    parsed.push_back(static_cast<uint32_t>(value));
    if (*end == '\0') break;
    item = end + 1;
    if (*item == '\0') return false;
  }
  *result = std::move(parsed);
  return true;
}

}  // namespace singz::tools
