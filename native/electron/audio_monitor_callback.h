#pragma once

#include <atomic>
#include <cstdint>

#include <zdsp/audio_host_graph_adapter.h>
#include <zcore/device/audio_host_render.h>

namespace singz {

// Callback-domain state is fully prepared by AudioMonitorSession. The thunk
// performs no ownership, allocation, locking, logging, or cross-thread calls.
struct AudioMonitorCallbackState {
  zdsp::AudioHostGraphAdapter* adapter{nullptr};
  std::atomic<uint32_t> deviceLost{0};
  std::atomic<uint32_t> terminalFailures{0};
};

bool audioMonitorRender(void* context,
                        const AudioHostRenderBlock& block) noexcept;

}  // namespace singz
