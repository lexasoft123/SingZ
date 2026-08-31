#include "native_playback_callback.h"

#include <limits>

namespace singz {
namespace {

constexpr uint32_t kCounterUpdateAttempts = 4;

void silence(const AudioHostRenderBlock& block) noexcept {
  if (block.output == nullptr) return;
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    float* samples = block.output[channel];
    if (samples == nullptr) continue;
    for (uint32_t frame = 0; frame < block.frames; ++frame)
      samples[frame] = 0.0F;
  }
}

void saturate(std::atomic<uint32_t>* value) noexcept {
  uint32_t old = value->load(std::memory_order_relaxed);
  for (uint32_t attempt = 0;
       attempt < kCounterUpdateAttempts &&
       old != std::numeric_limits<uint32_t>::max(); ++attempt) {
    if (value->compare_exchange_weak(old, old + 1,
                                     std::memory_order_relaxed,
                                     std::memory_order_relaxed))
      return;
  }
}

void latchTerminal(NativePlaybackCallbackState* state,
                   NativePlaybackCallbackTerminalReason reason) noexcept {
  AudioHostTerminalReason hostReason = AudioHostTerminalReason::ProviderFailure;
  if (reason == NativePlaybackCallbackTerminalReason::RouteChanged)
    hostReason = AudioHostTerminalReason::RouteChanged;
  else if (reason == NativePlaybackCallbackTerminalReason::DeviceLost)
    hostReason = AudioHostTerminalReason::DeviceLost;
  state->firstTerminalCause.publish(
      hostReason, AudioHostTerminalProducer::GraphCallback);
  saturate(&state->terminalFailures);
}

}  // namespace

bool nativePlaybackRender(void* context,
                          const AudioHostRenderBlock& block) noexcept {
  auto* state = static_cast<NativePlaybackCallbackState*>(context);
  // Containment starts from silence. A successful graph render overwrites it;
  // every rejected/partial/terminal path therefore remains inaudible.
  silence(block);
  NativePlaybackCallbackTerminalReason terminal =
      NativePlaybackCallbackTerminalReason::None;
  if ((block.discontinuity & AudioHostDiscontinuityDeviceLost) != 0)
    terminal = NativePlaybackCallbackTerminalReason::DeviceLost;
  else if ((block.discontinuity & AudioHostDiscontinuityRouteChanged) != 0)
    terminal = NativePlaybackCallbackTerminalReason::RouteChanged;
  if (state == nullptr) return false;
  if (state->firstTerminalCause.current().reason !=
      AudioHostTerminalReason::None) {
    saturate(&state->terminalFailures);
    return false;
  }
  if (terminal != NativePlaybackCallbackTerminalReason::None) {
    latchTerminal(state, terminal);
    return false;
  }
  if (state->adapter == nullptr) {
    latchTerminal(state,
                  NativePlaybackCallbackTerminalReason::RenderUnavailable);
    return false;
  }
  if (!zdsp::renderAudioHostGraph(state->adapter, block)) {
    silence(block);
    latchTerminal(state,
                  NativePlaybackCallbackTerminalReason::RenderUnavailable);
    return false;
  }
  return true;
}

}  // namespace singz
