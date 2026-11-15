#pragma once

#include "presentation_history.h"

namespace singz {

enum class RecordPlacementFault { None, HistoryMiss, ClockUnavailable, SeekDuringTake };

struct RecordPlacementInput {
  uint64_t firstSampleHostNs{0};
  uint64_t inputLatencyFrames{0}, outputLatencyFrames{0}, graphLatencyFrames{0};
  double sampleRate{0};
  // On later calls, pass the token returned for the first sample and the
  // latest sample's host time. No long-take history retention is necessary.
  bool hasInitialDiscontinuitySerial{false};
  uint64_t initialDiscontinuitySerial{0};
  // New consumers distinguish an affine tempo/key seam from a transport fault.
  bool hasInitialFaultSerial{false};
  uint64_t initialFaultSerial{0};
};

struct RecordPlacementResult {
  double startPositionSec{0};
  RecordPlacementFault fault{RecordPlacementFault::None};
  uint64_t alignedHostNs{0}, discontinuitySerial{0};
  uint64_t faultSerial{0};
};

// Capture timestamp C reaches the application inputLatency later than singing.
// At singing time C-I, the ear heard a song sample rendered O+G earlier.
// Therefore the journal lookup is C-I-O-G, NEVER C+I+O+G. Latencies are output
// wall-time frames, converted with sampleRate BEFORE looking up the historical
// tempo; subtracting song seconds at today's tempo is wrong across rate changes
// and pauses. For a true hardware sample timestamp, I must be zero if that
// timestamp has already removed input latency (macOS currently reports zero).
// The rate-1 captured take starts at this song position, with no extra stretch.
RecordPlacementResult recordPlacement(const PlaybackPresentationHistory &,
                                      const RecordPlacementInput &) noexcept;

} // namespace singz
