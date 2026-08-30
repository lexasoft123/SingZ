#pragma once

#include <cstdint>

namespace singz::detail {

// A rejected owner-gate entry must never return Stop to Oboe. On older Oboe
// paths Stop can schedule requestStop with the raw stream pointer after the
// callback returns, racing the serialized owner teardown.
constexpr bool androidAudioHostRejectedCallbackContinues() noexcept {
  return true;
}


struct AndroidAudioHostDrainState {
  uint32_t callbacksToDrain{20};
  uint32_t cushionCallbacks{1};
  uint32_t callbacksToDiscard{30};
};

enum class AndroidAudioHostDrainAction : uint32_t {
  Drain,
  Cushion,
  Discard,
  Render,
};

inline AndroidAudioHostDrainAction androidAudioHostDrainAction(
    AndroidAudioHostDrainState* state, bool drainProducedFrames) noexcept {
  if (state == nullptr) return AndroidAudioHostDrainAction::Render;
  if (state->callbacksToDrain != 0) {
    if (drainProducedFrames) --state->callbacksToDrain;
    return AndroidAudioHostDrainAction::Drain;
  }
  if (state->cushionCallbacks != 0) {
    --state->cushionCallbacks;
    return AndroidAudioHostDrainAction::Cushion;
  }
  if (state->callbacksToDiscard != 0) {
    --state->callbacksToDiscard;
    return AndroidAudioHostDrainAction::Discard;
  }
  return AndroidAudioHostDrainAction::Render;
}

struct AndroidAudioHostTimestampAnchor {
  uint64_t framePosition{0};
  uint64_t frameTimeNs{0};
  uint64_t sampledAtNs{0};
  bool valid{false};
};

struct AndroidAudioHostTimestampProjection {
  uint64_t hostTimeNs{0};
  bool hardware{false};
};

constexpr uint64_t kAndroidAudioHostTimestampFreshnessNs = 500000000ULL;

AndroidAudioHostTimestampProjection projectAndroidAudioHostTimestamp(
    const AndroidAudioHostTimestampAnchor& anchor, uint64_t framePosition,
    uint32_t sampleRate, uint64_t callbackEntryNs) noexcept;

bool androidAudioHostDeadlineMiss(uint64_t callbackEntryNs,
                                  uint64_t callbackEndNs, uint32_t frames,
                                  uint32_t sampleRate) noexcept;

struct AndroidAudioHostDriverXrunState {
  uint32_t input{0};
  uint32_t output{0};
};

inline bool androidAudioHostDriverXrunChanged(
    AndroidAudioHostDriverXrunState* state, uint32_t input,
    uint32_t output) noexcept {
  if (state == nullptr) return false;
  const bool changed = state->input != input || state->output != output;
  state->input = input;
  state->output = output;
  return changed;
}

}  // namespace singz::detail
