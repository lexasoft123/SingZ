#pragma once

#include <atomic>
#include <cstdint>

#include <zdsp/audio_host_graph_adapter.h>
#include <zcore/device/audio_host_render.h>

namespace singz {

enum class NativePlaybackCallbackTerminalReason : uint32_t {
  None = 0,
  RouteChanged = 1,
  DeviceLost = 2,
  RenderUnavailable = 3,
};

// Callback-domain state is fully prepared by NativePlaybackSession. It owns
// no graph/media lifetime and remains valid until AudioHost::stop has closed
// callback admission and drained the provider callback.
struct NativePlaybackCallbackState {
  zdsp::AudioHostGraphAdapter* adapter{nullptr};
  AudioHostTerminalCauseLatch firstTerminalCause{};
  std::atomic<uint32_t> terminalFailures{0};
};

bool nativePlaybackRender(void* context,
                          const AudioHostRenderBlock& block) noexcept;

}  // namespace singz
