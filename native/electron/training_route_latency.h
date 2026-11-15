#pragma once
#include <zcore/device/audio_host.h>
#include <zdsp/latency.h>
#include <cmath>
#include <optional>

namespace singz {
struct TrainingRouteLatency {
  zdsp::RouteLatencySnapshot snapshot{};
  zdsp::LatencyComposition composed{};
};
// Control-plane projection of one immutable host status. The provider's
// output-device, current I/O-buffer and external-route facts form its complete
// automatic estimate; components remain provenance, never a second addition.
inline std::optional<TrainingRouteLatency> trainingRouteLatency(
    const AudioHostStatus& host, uint64_t measuredAtNs) noexcept {
  const double rate = host.format.sampleRate;
  if (!std::isfinite(rate) || rate < 8000 || rate > 384000 ||
      (host.state != AudioHostState::Open && host.state != AudioHostState::Running &&
       host.state != AudioHostState::Suspended)) return std::nullopt;
  const auto ns = [rate](uint64_t frames) -> zdsp::LatencyNs {
    return {static_cast<int64_t>(std::llround(static_cast<double>(frames) * 1e9 / rate))};
  };
  TrainingRouteLatency result;
  auto& s = result.snapshot;
  s.interfaceVersion = zdsp::kRouteLatencySnapshotVersion;
  s.structSize = sizeof(s);
  s.routeGeneration = {host.routeGeneration};
  s.provenance = zdsp::RouteLatencyProvenance::PlatformReported;
  s.flags = zdsp::RouteLatencyAutomaticComplete | zdsp::RouteLatencyHasRenderDevice |
      zdsp::RouteLatencyHasExternalRoute;
  s.measuredAt = {measuredAtNs};
  const uint64_t renderFrames = uint64_t(host.latency.outputDeviceFrames) + host.latency.bufferFrames;
  s.automaticPresentation = ns(renderFrames + host.latency.externalRouteFrames);
  s.renderDevice = ns(renderFrames);
  s.externalRoute = ns(host.latency.externalRouteFrames);
  if (!zdsp::succeeded(zdsp::composeRouteLatency(s, &result.composed))) return std::nullopt;
  return result;
}
} // namespace singz
