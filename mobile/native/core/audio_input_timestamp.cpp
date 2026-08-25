#include "audio_input_timestamp.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace singz {
namespace {

constexpr uint64_t kMaximumSampleAgeNs = 500000000ull;
constexpr uint64_t kMaximumHardwareAnchorAgeNs = 5000000000ull;
constexpr uint64_t kMaximumProjectionBehindCallbackNs = 2000000000ull;
constexpr uint64_t kMaximumProjectionAheadOfCallbackNs = 50000000ull;

uint32_t low32(uint64_t value) {
  return static_cast<uint32_t>(value & 0xffffffffull);
}

uint32_t high32(uint64_t value) {
  return static_cast<uint32_t>(value >> 32u);
}

}  // namespace

uint64_t audioInputCallbackEntryFallback(uint64_t callbackEntryNs,
                                         uint32_t blockFrames,
                                         double sampleRate) {
  if (callbackEntryNs == 0 || blockFrames == 0 ||
      !std::isfinite(sampleRate) || sampleRate <= 0) {
    return 0;
  }
  const long double durationValue =
      static_cast<long double>(blockFrames) * 1000000000.0L /
      static_cast<long double>(sampleRate);
  if (!std::isfinite(durationValue) || durationValue <= 0) return callbackEntryNs;
  if (durationValue >= static_cast<long double>(callbackEntryNs)) return 1;
  return callbackEntryNs - static_cast<uint64_t>(durationValue);
}

AudioInputTimestampProjection resolveAudioInputTimestamp(
    bool hardwareTimestampValid, uint64_t hardwareTimestampNs,
    uint64_t callbackEntryNs, uint32_t blockFrames, double sampleRate) {
  if (hardwareTimestampValid && hardwareTimestampNs != 0)
    return {hardwareTimestampNs, true};
  return {audioInputCallbackEntryFallback(callbackEntryNs, blockFrames,
                                          sampleRate),
          false};
}

void AudioInputTimestampProjector::reset() {
  sequence_.fetch_add(1, std::memory_order_acq_rel);
  frameLow_.store(0, std::memory_order_relaxed);
  frameHigh_.store(0, std::memory_order_relaxed);
  timeLow_.store(0, std::memory_order_relaxed);
  timeHigh_.store(0, std::memory_order_relaxed);
  sampledLow_.store(0, std::memory_order_relaxed);
  sampledHigh_.store(0, std::memory_order_relaxed);
  sequence_.fetch_add(1, std::memory_order_release);
}

bool AudioInputTimestampProjector::publish(int64_t framePosition,
                                           int64_t frameTimeNs,
                                           uint64_t sampledAtNs) {
  if (framePosition < 0 || frameTimeNs <= 0 || sampledAtNs == 0) return false;
  const uint64_t time = static_cast<uint64_t>(frameTimeNs);
  if (time > sampledAtNs + kMaximumProjectionAheadOfCallbackNs ||
      sampledAtNs - std::min(sampledAtNs, time) > kMaximumHardwareAnchorAgeNs) {
    return false;
  }
  const uint64_t frame = static_cast<uint64_t>(framePosition);
  sequence_.fetch_add(1, std::memory_order_acq_rel);
  frameLow_.store(low32(frame), std::memory_order_relaxed);
  frameHigh_.store(high32(frame), std::memory_order_relaxed);
  timeLow_.store(low32(time), std::memory_order_relaxed);
  timeHigh_.store(high32(time), std::memory_order_relaxed);
  sampledLow_.store(low32(sampledAtNs), std::memory_order_relaxed);
  sampledHigh_.store(high32(sampledAtNs), std::memory_order_relaxed);
  sequence_.fetch_add(1, std::memory_order_release);
  return true;
}

AudioInputTimestampProjection AudioInputTimestampProjector::project(
    int64_t blockStartFrame, uint32_t blockFrames, int32_t sampleRate,
    uint64_t callbackEntryNs) const {
  const uint64_t fallback = audioInputCallbackEntryFallback(
      callbackEntryNs, blockFrames, sampleRate);
  if (blockStartFrame < 0 || sampleRate <= 0 || callbackEntryNs == 0)
    return {fallback, false};

  Snapshot anchor;
  if (!snapshot(anchor) || anchor.sampledAtNs > callbackEntryNs ||
      callbackEntryNs - anchor.sampledAtNs > kMaximumSampleAgeNs) {
    return {fallback, false};
  }
  const long double deltaFrames = static_cast<long double>(blockStartFrame) -
                                  static_cast<long double>(anchor.framePosition);
  const long double projected = static_cast<long double>(anchor.frameTimeNs) +
      deltaFrames * 1000000000.0L / static_cast<long double>(sampleRate);
  if (!std::isfinite(projected) || projected <= 0 ||
      projected > static_cast<long double>(std::numeric_limits<uint64_t>::max())) {
    return {fallback, false};
  }
  const uint64_t result = static_cast<uint64_t>(projected);
  if (result > callbackEntryNs + kMaximumProjectionAheadOfCallbackNs ||
      callbackEntryNs - std::min(callbackEntryNs, result) >
          kMaximumProjectionBehindCallbackNs) {
    return {fallback, false};
  }
  return {result, true};
}

bool AudioInputTimestampProjector::snapshot(Snapshot& out) const {
  for (int attempt = 0; attempt < 3; ++attempt) {
    const uint32_t before = sequence_.load(std::memory_order_acquire);
    if ((before & 1u) != 0) continue;
    const uint32_t frameLow = frameLow_.load(std::memory_order_relaxed);
    const uint32_t frameHigh = frameHigh_.load(std::memory_order_relaxed);
    const uint32_t timeLow = timeLow_.load(std::memory_order_relaxed);
    const uint32_t timeHigh = timeHigh_.load(std::memory_order_relaxed);
    const uint32_t sampledLow = sampledLow_.load(std::memory_order_relaxed);
    const uint32_t sampledHigh = sampledHigh_.load(std::memory_order_relaxed);
    const uint32_t after = sequence_.load(std::memory_order_acquire);
    if (before != after || (after & 1u) != 0) continue;
    out.framePosition = joinSigned(frameLow, frameHigh);
    out.frameTimeNs = joinSigned(timeLow, timeHigh);
    out.sampledAtNs = joinUnsigned(sampledLow, sampledHigh);
    return out.frameTimeNs > 0 && out.sampledAtNs > 0;
  }
  return false;
}

uint64_t AudioInputTimestampProjector::joinUnsigned(uint32_t low,
                                                    uint32_t high) {
  return static_cast<uint64_t>(low) | (static_cast<uint64_t>(high) << 32u);
}

int64_t AudioInputTimestampProjector::joinSigned(uint32_t low, uint32_t high) {
  return static_cast<int64_t>(joinUnsigned(low, high));
}

}  // namespace singz
