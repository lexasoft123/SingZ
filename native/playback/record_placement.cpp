#include "record_placement.h"

#include <cmath>

namespace singz {
RecordPlacementResult recordPlacement(const PlaybackPresentationHistory &history,
                                      const RecordPlacementInput &input) noexcept {
  RecordPlacementResult result;
  if (!input.firstSampleHostNs || !std::isfinite(input.sampleRate) || input.sampleRate <= 0) {
    result.fault = RecordPlacementFault::ClockUnavailable;
    return result;
  }
  // Sum in floating point before conversion: even malicious frame counters
  // must not wrap the unsigned sum or trigger an out-of-range integer cast.
  const long double frames = static_cast<long double>(input.inputLatencyFrames) +
      input.outputLatencyFrames + input.graphLatencyFrames;
  const long double delayNs = std::floor(frames * 1.e9L / input.sampleRate + .5L);
  if (!std::isfinite(delayNs) || delayNs >= input.firstSampleHostNs) {
    result.fault = RecordPlacementFault::ClockUnavailable;
    return result;
  }
  result.alignedHostNs = input.firstSampleHostNs - static_cast<uint64_t>(delayNs);
  const auto point = history.query(result.alignedHostNs);
  result.discontinuitySerial = point.discontinuitySerial;
  if (point.nonAffine || (point.found && input.hasInitialDiscontinuitySerial &&
                         point.discontinuitySerial != input.initialDiscontinuitySerial)) {
    result.fault = RecordPlacementFault::SeekDuringTake;
  } else if (!point.found) {
    result.fault = RecordPlacementFault::HistoryMiss;
  } else {
    result.startPositionSec = point.songSeconds;
  }
  return result;
}
} // namespace singz
