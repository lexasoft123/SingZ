#pragma once

#include <cstdint>

namespace singz {

enum class AudioInputTimestampQuality : uint8_t {
  Unknown = 0,
  Hardware = 1,
  CallbackEstimate = 2,
};

// Device/capture reasons only. DSP-only seek/loop/route reasons live in
// zdsp; the higher-layer capture adapter maps these values explicitly.
enum class AudioInputDiscontinuityReason : uint8_t {
  None = 0,
  StreamGenerationChanged,
  SequenceGap,
  SampleRateChanged,
  TimestampQualityChanged,
  ClockReanchored,
  DeviceLost,
  SourceFrameOverflow,
};

enum AudioInputCaptureFlags : uint32_t {
  AudioInputCaptureNone = 0,
  AudioInputSourceFrameValid = 1u << 0,
  AudioInputSampleHostTimeValid = 1u << 1,
  AudioInputCallbackHostTimeValid = 1u << 2,
  AudioInputTimestampQualityValid = 1u << 3,
  AudioInputStaleAnchor = 1u << 4,
  AudioInputDiscontinuous = 1u << 5,
};

// Copyable capture provenance stored beside PCM in the preallocated ring.
// It contains device truth only: output-route latency is never projected into
// these timestamps.
struct AudioInputCaptureMetadata {
  uint64_t clockDomainId = 0;
  uint64_t streamGeneration = 0;
  uint64_t sequence = 0;
  uint64_t sourceFrame = 0;
  uint64_t sampleHostTimeNs = 0;
  uint64_t callbackHostTimeNs = 0;
  AudioInputTimestampQuality timestampQuality =
      AudioInputTimestampQuality::Unknown;
  AudioInputDiscontinuityReason discontinuity =
      AudioInputDiscontinuityReason::None;
  uint32_t flags = AudioInputCaptureNone;
};

}  // namespace singz
