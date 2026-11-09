#pragma once
#include <memory>
#include <string>
#include <zcore/device/audio_host.h>
#include <zcore/device/audio_input.h>
#include <zcore/device/audio_input_backend.h>
#include <functional>
#include <cstdint>
namespace loopz { class AudioSource; }
namespace singz {
struct LoopZSongSource;
// Lifecycle, request, poll, backend construction and presentation queries run
// on ONE serialized control owner. Adapters drain playback before shutdown.
// Only the explicitly documented record callbacks and atomic health getters
// below may run concurrently with that owner or on audio threads. noexcept by
// itself does not imply callback safety or concurrent control access.
using BoxRoutingHostFactory = std::function<std::unique_ptr<AudioHostBackend>()>;
using BoxRoutingInputFactory = std::function<std::unique_ptr<AudioInputBackend>()>;
bool initializeBoxRouting(const std::string& statePath, std::string& error);
// Dependency injection for deterministic integration tests; normal application
// initialization always selects the platform factory. Inventory discovery is
// shared across temporary hosts and cached for one monotonic second, including
// failures. The optional inventory clock is control-owner-only and test-local;
// it also drives the Control::poll throttle below.
bool initializeBoxRoutingWithHost(const std::string& statePath, std::string& error,
                                  BoxRoutingHostFactory factory,
                                  std::shared_ptr<LoopZSongSource> source = {},
                                  BoxRoutingInputFactory inputFactory = {},
                                  std::function<uint64_t()> inventoryClock = {});
// Control-owner diagnostic: non-empty after initialization moved an unreadable,
// invalid, newer or symlinked saved routing document aside (the Box has no
// keyboard to repair it) and started with no saved routing.
std::string boxRoutingStateRecovery();
namespace box_routing_detail {
// Control::poll() rebuilds a temporary inventory host and, while the desired
// generation is not active, re-runs a full AudioRuntime::prepare (scene build
// and device open attempts). The JS owner ticks every 25 ms for mapping
// freshness; Control itself polls at most every 250 ms, and only every 2 s
// (LoopZ's own engine cadence) while activation is pending.
constexpr uint64_t kControlPollNs = 250000000, kPendingActivationPollNs = 2000000000;
constexpr bool controlPollDue(bool polled, uint64_t lastNs, uint64_t nowNs,
                              bool activationPending) noexcept {
  return !polled || nowNs < lastNs ||
         nowNs - lastNs >= (activationPending ? kPendingActivationPollNs : kControlPollNs);
}
} // namespace box_routing_detail
// Atomic health getters: safe concurrently, including from audio callbacks.
bool boxRoutingInitialized() noexcept;
// Telemetry loss never stops routes; projection stays unavailable until a full
// drained shutdown/reinitialization resets this diagnostic.
bool boxRoutingTimingCoverageLost() noexcept;
std::string boxRoutingRequest(const std::string& request);
void pollBoxRouting();
void shutdownBoxRouting() noexcept;
std::unique_ptr<AudioHostBackend> boxRoutingPlaybackBackend();
// The routing owner retains physical inputs. Private consumers borrow history;
// their reader must be stopped/joined before releasing this control-owner lease.
bool boxRoutingOwnsCapture() noexcept;
struct BoxInputTap {
  uint64_t id{};
  const loopz::AudioSource* source{};
  AudioInputDevice device;
};
std::vector<AudioInputDevice> boxRoutingInputDevices();
BoxInputTap acquireBoxInputTap(const std::string& uid, uint32_t channel);
void releaseBoxInputTap(uint64_t id) noexcept;
} // namespace singz

namespace singz {
// Called once for each transport slice, on the single native producer. Fixed
// storage only; source boundaries stay represented rather than extrapolated.
void recordBoxSongSlice(uint64_t hostNs, uint32_t frames, uint64_t generation,
                        int64_t projectFrame, uint32_t fractionQ32,
                        uint64_t rateQ32, uint32_t state, uint64_t seekCount) noexcept;
// Bounded callback-safe failed-PCM marker; may run on producer/render threads.
void recordBoxSongFailure(uint64_t hostNs, uint32_t frames) noexcept;
struct BoxAudibleProjection {
  bool available{false};
  int64_t projectFrame{0};
  uint64_t routeDelayFrames{0};
};
// Serialized CONTROL-OWNER query, alongside request/poll/lifecycle. This reads
// the current mapping configuration, samples steady_clock and scans bounded
// journals; it must NOT run in a render callback or concurrently with mapping
// updates. In Electron it is called by the synchronous playbackStatus NAPI
// handler, never by asynchronous prepare/measurement workers.
BoxAudibleProjection boxAudibleProjection(uint64_t generation, uint64_t seekCount,
                                        uint64_t graphLatencyFrames) noexcept;
// Deterministic fixture seam: runs the identical checks with an explicit query
// clock. Same serialized control-owner contract; never bypasses physical clock,
// history coverage, epoch or journal checks. Production uses steady_clock above.
BoxAudibleProjection boxAudibleProjectionAtTimeForTesting(
    uint64_t generation, uint64_t seekCount, uint64_t graphLatencyFrames,
    uint64_t queryHostNs) noexcept;
}
