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

// One generation replacing another ON THE RUNNING STREAM. The session fills
// this off the render thread, then publishes it through the router below with
// a release store; the render thread lands it at a block boundary of its own
// choosing and the outgoing graph never renders a frame after the landing.
struct NativePlaybackSwapRequest {
  NativePlaybackCallbackState* incoming{nullptr};
  void* context{nullptr};
  // How many frames of this block still belong to the OUTGOING graph:
  // block.frames when the landing is not in this block, 0 to land on its
  // first frame, anything between to split the block at that offset. Runs
  // once per block on the render thread, before any rendering.
  uint32_t (*outgoingFrames)(void*, const AudioHostRenderBlock&) noexcept{
      nullptr};
  // The clock handoff, on the render thread, between the outgoing graph's
  // last frame and the incoming graph's first. `offset` is where in the block
  // that seam falls.
  void (*land)(void*, uint32_t offset) noexcept{nullptr};
};

// The host's render context for the whole session: which generation renders,
// and whether another is waiting to take over. Owned by the session and by
// every graph it has ever pointed at (a graph whose callback never quiesced
// keeps it alive), so the render thread never dereferences freed memory.
struct NativePlaybackRenderRouter {
  std::atomic<NativePlaybackCallbackState*> current{nullptr};
  std::atomic<const NativePlaybackSwapRequest*> swap{nullptr};
  // Landings the render thread has completed. A landing is published AFTER
  // the outgoing graph's last render returned, so an observer that sees the
  // count move (acquire) knows that graph's runner is idle.
  std::atomic<uint32_t> swapsLanded{0};
};

static_assert(std::atomic<NativePlaybackCallbackState*>::is_always_lock_free);
static_assert(
    std::atomic<const NativePlaybackSwapRequest*>::is_always_lock_free);

bool nativePlaybackRender(void* context,
                          const AudioHostRenderBlock& block) noexcept;

}  // namespace singz
