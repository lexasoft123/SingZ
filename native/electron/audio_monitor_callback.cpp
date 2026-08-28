#include "audio_monitor_callback.h"

#include <limits>

namespace singz {
namespace {

void silence(const AudioHostRenderBlock& block) noexcept {
  if (block.output == nullptr) return;
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    if (block.output[channel] == nullptr) continue;
    for (uint32_t frame = 0; frame < block.frames; ++frame)
      block.output[channel][frame] = 0.0F;
  }
}

void saturate(std::atomic<uint32_t>* value) noexcept {
  uint32_t old = value->load(std::memory_order_relaxed);
  while (old != std::numeric_limits<uint32_t>::max() &&
         !value->compare_exchange_weak(old, old + 1,
                                       std::memory_order_relaxed,
                                       std::memory_order_relaxed)) {
  }
}

}  // namespace

bool audioMonitorRender(void* context,
                        const AudioHostRenderBlock& block) noexcept {
  auto* state = static_cast<AudioMonitorCallbackState*>(context);
  if (state == nullptr || state->adapter == nullptr ||
      (block.discontinuity & AudioHostDiscontinuityDeviceLost) != 0) {
    silence(block);
    if (state != nullptr) {
      state->deviceLost.store(1, std::memory_order_release);
      saturate(&state->terminalFailures);
    }
    return false;
  }
  // The adapter owns its own render-failure counter. Do not wrap or count that
  // result again: terminal failures represent only failures intercepted here.
  return zdsp::renderAudioHostGraph(state->adapter, block);
}

}  // namespace singz
