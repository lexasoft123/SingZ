#include "native_playback_callback.h"

#include <array>
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

// One generation's render of one (sub)block: today's whole callback body.
bool renderGeneration(NativePlaybackCallbackState* state,
                      const AudioHostRenderBlock& block) noexcept {
  if (state->firstTerminalCause.current().reason !=
      AudioHostTerminalReason::None) {
    saturate(&state->terminalFailures);
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

// The frames [offset, offset + frames) of `block` as a block of their own.
// Output-only, like every playback stream: the host has no input to shift.
bool subview(const AudioHostRenderBlock& block, uint32_t offset,
             uint32_t frames,
             std::array<float*, kAudioHostMaxChannels>* pointers,
             AudioHostRenderBlock* view) noexcept {
  if (offset > block.frames || frames == 0 || frames > block.frames - offset ||
      block.outputChannels > kAudioHostMaxChannels || block.input != nullptr ||
      block.output == nullptr)
    return false;
  *view = block;
  view->frames = frames;
  view->outputFrame = advanceAudioHostFrame(block.outputFrame, offset);
  if (block.outputTimestampValid && block.sampleRate > 0.0) {
    const double shiftNs = static_cast<double>(offset) * 1.0e9 /
                           block.sampleRate;
    const double shifted = static_cast<double>(block.outputHostTimeNs) +
                           shiftNs;
    view->outputHostTimeNs =
        shifted >= 18446744073709551616.0
            ? std::numeric_limits<uint64_t>::max()
            : static_cast<uint64_t>(shifted);
  }
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    if (block.output[channel] == nullptr) return false;
    (*pointers)[channel] = block.output[channel] + offset;
  }
  view->output = pointers->data();
  return true;
}

}  // namespace

bool nativePlaybackRender(void* context,
                          const AudioHostRenderBlock& block) noexcept {
  auto* router = static_cast<NativePlaybackRenderRouter*>(context);
  // Containment starts from silence. A successful graph render overwrites it;
  // every rejected/partial/terminal path therefore remains inaudible.
  silence(block);
  if (router == nullptr) return false;
  NativePlaybackCallbackState* state =
      router->current.load(std::memory_order_acquire);
  if (state == nullptr) return false;
  NativePlaybackCallbackTerminalReason terminal =
      NativePlaybackCallbackTerminalReason::None;
  if ((block.discontinuity & AudioHostDiscontinuityDeviceLost) != 0)
    terminal = NativePlaybackCallbackTerminalReason::DeviceLost;
  else if ((block.discontinuity & AudioHostDiscontinuityRouteChanged) != 0)
    terminal = NativePlaybackCallbackTerminalReason::RouteChanged;
  if (terminal != NativePlaybackCallbackTerminalReason::None) {
    // Latched on the generation that is rendering; a waiting swap stays
    // waiting, since a stream this is happening to is about to stop.
    latchTerminal(state, terminal);
    return false;
  }
  const NativePlaybackSwapRequest* swap =
      router->swap.load(std::memory_order_acquire);
  if (swap == nullptr || swap->incoming == nullptr ||
      swap->outgoingFrames == nullptr || swap->land == nullptr)
    return renderGeneration(state, block);
  // A latched outgoing generation is a stream about to stop; the swap stays
  // waiting rather than landing on a graph whose first terminal cause the
  // session has yet to merge.
  if (state->firstTerminalCause.current().reason !=
      AudioHostTerminalReason::None)
    return renderGeneration(state, block);

  const uint32_t outgoing = swap->outgoingFrames(swap->context, block);
  if (outgoing >= block.frames) return renderGeneration(state, block);
  std::array<float*, kAudioHostMaxChannels> pointers{};
  AudioHostRenderBlock view{};
  if (outgoing != 0) {
    if (!subview(block, 0, outgoing, &pointers, &view) ||
        !renderGeneration(state, view))
      return false;
  }
  // The seam. Nothing of the outgoing graph runs after this point, and the
  // landing is published only once its last render has returned. Once it is
  // published the request may be rewritten for the next swap, so nothing of
  // it is touched after the stores below.
  NativePlaybackCallbackState* incoming = swap->incoming;
  swap->land(swap->context, outgoing);
  router->current.store(incoming, std::memory_order_release);
  router->swap.store(nullptr, std::memory_order_release);
  router->swapsLanded.fetch_add(1u, std::memory_order_acq_rel);
  if (!subview(block, outgoing, block.frames - outgoing, &pointers, &view))
    return false;
  // The block's host flags were coalesced by the outgoing transport at its
  // first frame and travelled across in the handoff; the incoming graph must
  // not queue them a second time.
  view.discontinuity = AudioHostDiscontinuityNone;
  return renderGeneration(incoming, view);
}

}  // namespace singz
