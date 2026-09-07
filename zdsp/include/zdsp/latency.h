#pragma once

#include "zdsp/types.h"

namespace zdsp {

inline constexpr uint32_t kRouteLatencySnapshotVersion = 1;
enum class RouteLatencyProvenance : uint32_t {
  Unknown = 0, PlatformReported, PlatformMeasured, LoopbackMeasured, UserCalibrated,
};
enum RouteLatencyFlags : uint32_t {
  RouteLatencyNone = 0,
  RouteLatencyAutomaticComplete = 1u << 0,
  RouteLatencyHasCapture = 1u << 1,
  RouteLatencyHasInputConversion = 1u << 2,
  RouteLatencyHasRenderDevice = 1u << 3,
  RouteLatencyHasExternalRoute = 1u << 4,
  RouteLatencyHasUserTrim = 1u << 5,
  RouteLatencyHighVariance = 1u << 6,
};
struct RouteLatencySnapshot {
  uint32_t interfaceVersion;
  uint32_t structSize;
  RouteGeneration routeGeneration;
  RouteLatencyProvenance provenance;
  uint32_t flags;
  uint32_t confidencePermille;
  LatencyNs automaticPresentation;
  LatencyNs captureDevice;
  LatencyNs inputConversion;
  LatencyNs renderDevice;
  LatencyNs externalRoute;
  LatencyNs userTrim;
  HostTimeNs measuredAt;
};
// measuredAt was deliberately appended after the immutable V1 composition
// prefix. Readers must not inspect it unless structSize reaches that field.
inline constexpr uint32_t kRouteLatencySnapshotV1RequiredSize =
    static_cast<uint32_t>(offsetof(RouteLatencySnapshot, userTrim) +
                          sizeof(decltype(RouteLatencySnapshot::userTrim)));
inline constexpr uint32_t kRouteLatencySnapshotMeasuredAtSize =
    static_cast<uint32_t>(offsetof(RouteLatencySnapshot, measuredAt) +
                          sizeof(decltype(RouteLatencySnapshot::measuredAt)));
struct LatencyComposition {
  LatencyNs captureToGraph;
  LatencyNs graphToAudible;
  LatencyNs totalPresentation;
};
[[nodiscard]] ZDSP_INTERNAL_API Status composeRouteLatency(
    const RouteLatencySnapshot& snapshot,
    LatencyComposition* result) noexcept;

}  // namespace zdsp
