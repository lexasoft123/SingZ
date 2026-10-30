#pragma once

#include "zdsp/processor.h"

namespace zdsp {

// Control-domain view over immutable planar samples. The enclosing session
// keeps every pointed-to channel alive until the processor is deactivated and
// destroyed. The processor copies these pointers into fixed state; it does not
// participate in media lifetime management.
// The sequential cursor starts at frame zero during prepare and reset
// preserves it. Transport-positioned playback uses the separate prepared
// source contract below.
struct DecodedBufferView {
  const float *const *channels;
  uint32_t channelCount;
  uint64_t frameCount;
  SampleRateHz sampleRate;
};

struct DecodedBufferSourceConfig {
  NodeId node;
  DecodedBufferView buffer;
};

// Transport-positioned source mapping. Before entryProjectTimeSamples the
// source emits silence and publishes sourceStartFrame without advancing it.
// At and after entry, source frame N is:
//   sourceStartFrame + (projectTimeSamples - entryProjectTimeSamples)
// This keeps count-in pre-roll, seeks and loop re-anchors independent of host
// callback partitioning. A valid transport that is not playing emits silence
// and preserves the last published cursor. sourceStartFrame may equal
// frameCount for an empty entry point at the end of a lane.
struct PositionedDecodedBufferSourceConfig {
  NodeId node;
  DecodedBufferView buffer;
  int64_t entryProjectTimeSamples;
  uint64_t sourceStartFrame;
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
  void (*betweenReads)(void *, uint32_t attempt) noexcept {nullptr};
  void *context{nullptr};
};

[[nodiscard]] ZDSP_INTERNAL_API size_t decodedBufferSourceStateBytes() noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ProcessorHandle
createDecodedBufferSource(const DecodedBufferSourceConfig &config,
                          MutableByteView stateStorage) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ProcessorHandle
createPositionedDecodedBufferSource(
    const PositionedDecodedBufferSourceConfig &config,
    MutableByteView stateStorage) noexcept;
// Nonblocking control-domain snapshot of the callback-owned cursor. The value
// may advance while it is sampled, but is never torn and never exceeds the
// source frame count. Invalid/non-source handles return zero.
[[nodiscard]] ZDSP_INTERNAL_API uint64_t decodedBufferSourceCursor(
    const ProcessorHandle &processor,
    DecodedBufferSourceCursorReader *reader = nullptr,
    const DecodedBufferSourceCursorReadHook *hook = nullptr) noexcept;

} // namespace zdsp
