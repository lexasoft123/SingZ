#pragma once

#include "zdsp/events.h"

namespace zdsp {

enum class CaptureTimestampQuality : uint32_t {
  Unknown = 0,
  Estimated,
  Hardware,
};
enum CaptureTimeFlags : uint32_t {
  CaptureTimeNone = 0,
  CaptureTimeSourceFrameValid = 1u << 0,
  CaptureTimeSampleHostValid = 1u << 1,
  CaptureTimeCallbackHostValid = 1u << 2,
  CaptureTimeStaleAnchor = 1u << 3,
};
struct CaptureTime {
  ClockDomainId clockDomain;
  StreamGeneration streamGeneration;
  uint64_t sequence;
  FramePosition sourceFrame;
  HostTimeNs sampleHostTime;
  HostTimeNs callbackHostTime;
  CaptureTimestampQuality quality;
  Discontinuity discontinuity;
  uint32_t flags;
};

}  // namespace zdsp
