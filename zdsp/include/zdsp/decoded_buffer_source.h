#pragma once

#include "zdsp/processor.h"

namespace zdsp {

// Control-domain view over immutable planar samples. The enclosing session
// keeps every pointed-to channel alive until the processor is deactivated and
// destroyed. The processor copies these pointers into fixed state; it does not
// participate in media lifetime management.
// The cursor starts at frame zero during prepare. Processor reset preserves it;
// positioned seek/loop belongs to a future transport/source contract.
struct DecodedBufferView {
  const float* const* channels;
  uint32_t channelCount;
  uint64_t frameCount;
  SampleRateHz sampleRate;
};

struct DecodedBufferSourceConfig {
  NodeId node;
  DecodedBufferView buffer;
};

// Single control-domain reader state. A bounded snapshot retry that loses to
// the render thread returns this previously verified value, never an
// unverified low/high pair. Do not share one reader between control threads.
struct DecodedBufferSourceCursorReader {
  uint64_t lastGoodFrames{0};
};

// Deterministic concurrency hook for contract tests. The callback runs
// between the split-word reads and may force another render publication.
// Product code passes nullptr.
struct DecodedBufferSourceCursorReadHook {
  void (*betweenReads)(void*, uint32_t attempt) noexcept{nullptr};
  void* context{nullptr};
};

[[nodiscard]] ZDSP_INTERNAL_API size_t decodedBufferSourceStateBytes() noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ProcessorHandle createDecodedBufferSource(
    const DecodedBufferSourceConfig& config,
    MutableByteView stateStorage) noexcept;
// Nonblocking control-domain snapshot of the callback-owned cursor. The value
// may advance while it is sampled, but is never torn and never exceeds the
// source frame count. Invalid/non-source handles return zero.
[[nodiscard]] ZDSP_INTERNAL_API uint64_t decodedBufferSourceCursor(
    const ProcessorHandle& processor,
    DecodedBufferSourceCursorReader* reader = nullptr,
    const DecodedBufferSourceCursorReadHook* hook = nullptr) noexcept;

}  // namespace zdsp
