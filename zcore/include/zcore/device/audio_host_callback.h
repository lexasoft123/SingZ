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

void prepareAudioHostCallback(AudioHostCallbackEndpoint* endpoint,
                              AudioHostRender render, void* context) noexcept;
void activateAudioHostCallback(AudioHostCallbackEndpoint* endpoint) noexcept;
void deactivateAudioHostCallback(AudioHostCallbackEndpoint* endpoint) noexcept;
bool invokeAudioHostCallback(AudioHostCallbackEndpoint* endpoint,
                             const AudioHostRenderBlock& block) noexcept;
void recordAudioHostXRun(AudioHostCallbackEndpoint* endpoint) noexcept;
void recordAudioHostDeadlineMiss(AudioHostCallbackEndpoint* endpoint) noexcept;

}  // namespace singz
