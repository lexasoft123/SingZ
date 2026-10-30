#pragma once

#include "zdsp/decoded_buffer_source.h"
#include "zdsp/processor.h"

#include <atomic>

namespace zdsp {

// A positioned source that plays out of a MOVING window instead of the whole
// decoded song.
//
// The decoded-buffer source (decoded_buffer_source.h) needs every sample of
// every lane resident before the first one can be heard: on a phone that is
// ~1.3 s of decoding and ~650 MB across six lanes, all spent before the singer
// hears anything. This source instead reads a window that a control-domain
// feeder keeps ahead of playback, so the cost of starting is one window rather
// than one song.
//
// The transport mapping is deliberately IDENTICAL to the positioned decoded
// source: source frame N at project position P is
//   sourceStartFrame + (P - entryProjectTimeSamples)
// which is what keeps a seek, a count-in pre-roll and a loop re-anchor
// independent of how the host partitions its callbacks. Only where the samples
// come from changes.
//
// The window is therefore addressed by SOURCE frame, never by ring offset: the
// render thread asks for the frame its transport position names, and either
// that frame is in the window or it is not. A source frame that is not in
// the window renders silence and is counted, and the frame it wanted is
// published
// for the feeder to chase. Silence is the only honest answer available on the
// render thread — the alternative is a file operation there, which is exactly
// what this node exists to avoid.

// Split-word publication of a 64-bit frame range across domains.
//
// Two 32-bit halves, double-buffered behind a sequence, because a 64-bit
// atomic is not guaranteed lock-free on every ABI this ships to and a torn
// range is a wrong answer rather than a stale one. `start` and `end` share one
// sequence so a snapshot can never mix halves of two different windows.
struct StreamingWindowRange {
  std::atomic<uint32_t> sequence;
  std::atomic<uint32_t> startLow[2];
  std::atomic<uint32_t> startHigh[2];
  std::atomic<uint32_t> endLow[2];
  std::atomic<uint32_t> endHigh[2];
};

// Shared state between the feeder (control domain) and the node (render
// thread). The feeder owns `channels` storage and keeps it alive until the
// processor is deactivated and destroyed; the node treats it as immutable
// storage whose CONTENTS the feeder may change outside the published range.
struct StreamingWindow {
  // One plane per channel, each `capacityFrames` long. Source frame F lives at
  // index F & (capacityFrames - 1) whenever F is inside the published range.
  float *const *channels;
  uint32_t channelCount;
  // Power of two, so the index is a mask rather than a division.
  uint64_t capacityFrames;
  // The whole song, from the container. The node never plays past it.
  uint64_t totalFrames;
  SampleRateHz sampleRate;

  // Published by the feeder: the source-frame range now resident, end
  // exclusive.
  StreamingWindowRange resident;
  // Published by the node: the first source frame the last block wanted. The
  // feeder chases this — a jump outside the window is a seek.
  StreamingWindowRange demand;
  // Blocks that rendered at least one frame of silence because the window did
  // not hold it. Diagnostic only; the render thread never acts on it.
  std::atomic<uint32_t> starvedBlocks;
};

struct PositionedStreamingSourceConfig {
  NodeId node;
  StreamingWindow *window;
  int64_t entryProjectTimeSamples;
  uint64_t sourceStartFrame;
};

[[nodiscard]] ZDSP_INTERNAL_API size_t streamingWindowSourceStateBytes() noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ProcessorHandle
createPositionedStreamingSource(const PositionedStreamingSourceConfig &config,
                                MutableByteView stateStorage) noexcept;

// Nonblocking snapshot of the callback-owned cursor, in source frames.
//
// Deliberately the SAME reader type the decoded source uses: a lane holds one
// reader across a rebuild, and a session that swapped a decoded lane for a
// streamed one would otherwise have to carry two. Invalid or non-streaming
// handles return zero, so the two readers cannot be crossed by accident.
[[nodiscard]] ZDSP_INTERNAL_API uint64_t streamingWindowSourceCursor(
    const ProcessorHandle &processor,
    DecodedBufferSourceCursorReader *reader = nullptr) noexcept;

// Control-domain side of the window. All four are plain atomic operations and
// safe to call from either domain, but the division of labour is fixed: the
// feeder publishes the resident range, the node publishes demand.
ZDSP_INTERNAL_API void
streamingWindowPublishResident(StreamingWindow *window, uint64_t start,
                               uint64_t end) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API bool
streamingWindowResident(const StreamingWindow *window, uint64_t *start,
                        uint64_t *end) noexcept;
// The frame playback last wanted. False when no block has run yet, or when the
// value could not be sampled without tearing.
[[nodiscard]] ZDSP_INTERNAL_API bool
streamingWindowDemand(const StreamingWindow *window, uint64_t *frame) noexcept;
// Prepare the window for use before any block runs: an empty resident range at
// `start`, and demand pointing there so a feeder can prime before playback.
ZDSP_INTERNAL_API void streamingWindowInitialize(StreamingWindow *window,
                                                 uint64_t start) noexcept;

} // namespace zdsp
