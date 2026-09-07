#pragma once

#include <atomic>
#include <cstdint>

#include <zcore/device/audio_host_render.h>

namespace singz {

// The provider prepares this endpoint off RT and activates it only after its
// stream is fully initialized. invoke() is the strict callback leaf.
struct AudioHostCallbackEndpoint {
  std::atomic<AudioHostRender> render{nullptr};
  std::atomic<void*> context{nullptr};
  std::atomic<uint32_t> active{0};
  std::atomic<uint32_t> inFlight{0};
  // Callback-reachable counters deliberately stay 32-bit: this remains
  // lock-free on supported 32-bit mobile ABIs. They saturate rather than wrap
  // and are widened by the control-domain status snapshot.
  std::atomic<uint32_t> callbacks{0};
  std::atomic<uint32_t> renderedFrames{0};
  std::atomic<uint32_t> xruns{0};
  std::atomic<uint32_t> deadlineMisses{0};
  std::atomic<uint32_t> discontinuities{0};
  std::atomic<uint32_t> invalidCallbacks{0};
  std::atomic<uint32_t> renderFailures{0};
};

// Callback-owned output-clock continuity state. The provider resets this only
// while callback admission is closed. Hardware timestamp validity transitions
// and non-contiguous sample positions are explicit graph reset boundaries.
struct AudioHostOutputTimeline {
  uint64_t expectedFrame{0};
  uint32_t initialized{0};
  uint32_t sampleTimeValid{0};
  uint32_t hostTimeValid{0};
};

struct AudioHostOutputTimelineResult {
  uint64_t outputFrame{0};
  uint32_t discontinuity{AudioHostDiscontinuityNone};
};

constexpr uint32_t audioHostFinalActionFlags(uint32_t flags,
                                             uint32_t outputSilenceMask,
                                             bool outputIsSilent) noexcept {
  return outputIsSilent ? flags | outputSilenceMask
                        : flags & ~outputSilenceMask;
}

constexpr bool audioHostInputPullFailed(int32_t status, uint32_t inputFlags,
                                        uint32_t postRenderErrorMask) noexcept {
  return status != 0 || (inputFlags & postRenderErrorMask) != 0;
}

AudioHostOutputTimelineResult resolveAudioHostOutputTimeline(
    AudioHostOutputTimeline* timeline, bool sampleTimeValid,
    uint64_t sampleFrame, bool hostTimeValid, uint32_t frames,
    uint64_t fallbackFrame) noexcept;

void prepareAudioHostCallback(AudioHostCallbackEndpoint* endpoint,
                              AudioHostRender render, void* context) noexcept;
void activateAudioHostCallback(AudioHostCallbackEndpoint* endpoint) noexcept;
void deactivateAudioHostCallback(AudioHostCallbackEndpoint* endpoint) noexcept;
bool invokeAudioHostCallback(AudioHostCallbackEndpoint* endpoint,
                             const AudioHostRenderBlock& block) noexcept;
void recordAudioHostXRun(AudioHostCallbackEndpoint* endpoint) noexcept;
void recordAudioHostDeadlineMiss(AudioHostCallbackEndpoint* endpoint) noexcept;

}  // namespace singz
