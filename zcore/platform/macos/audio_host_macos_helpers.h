#pragma once

#include <cmath>
#include <cstdint>
#include <limits>

namespace singz::detail {

inline uint32_t saturatedAudioHostLatency(uint32_t deviceFrames,
                                          uint32_t safetyFrames) noexcept {
  const uint64_t total = static_cast<uint64_t>(deviceFrames) + safetyFrames;
  return total > std::numeric_limits<uint32_t>::max()
             ? std::numeric_limits<uint32_t>::max()
             : static_cast<uint32_t>(total);
}

inline bool checkedAudioHostFrameCount(double value, uint32_t* result) noexcept {
  if (result == nullptr || !std::isfinite(value) || value < 0.0 ||
      value > static_cast<double>(std::numeric_limits<uint32_t>::max()) ||
      std::floor(value) != value) {
    return false;
  }
  *result = static_cast<uint32_t>(value);
  return true;
}

inline bool checkedAudioHostBufferRange(double minimum, double maximum,
                                        uint32_t* minimumFrames,
                                        uint32_t* maximumFrames) noexcept {
  if (minimumFrames == nullptr || maximumFrames == nullptr) return false;
  uint32_t checkedMinimum = 0;
  uint32_t checkedMaximum = 0;
  if (!checkedAudioHostFrameCount(minimum, &checkedMinimum) ||
      !checkedAudioHostFrameCount(maximum, &checkedMaximum) ||
      checkedMinimum > checkedMaximum) {
    return false;
  }
  *minimumFrames = checkedMinimum;
  *maximumFrames = checkedMaximum;
  return true;
}

}  // namespace singz::detail
